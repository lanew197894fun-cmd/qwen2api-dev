const { isJson, generateUUID } = require("../utils/tools.js");
const { createUsageObject } = require("../utils/precise-tokenizer.js");
const { sendChatRequest } = require("../utils/request.js");
const {
  createToolCallStreamParser,
  parseToolCallsFromText,
} = require("../utils/tool-prompt.js");
const accountManager = require("../utils/account.js");
const config = require("../config/index.js");
const axios = require("axios");
const { logger } = require("../utils/logger");
const {
  assertNoUpstreamFailure,
  isWafChallengeError,
  chatBreakerState,
  noteChatChallenge,
} = require("../utils/upstream-error.js");

/**
 * 把上游失敗原因對應成 HTTP 回應
 * @param {string} code - 上層錯誤碼（waf_challenge / waf_breaker_open 等）
 * @returns {{status: number, body: Object, retryAfter: number}|null} 可直接寫入的錯誤回應
 */
function buildUpstreamErrorResponse(code) {
  if (!code || !String(code).startsWith("waf_")) return null;
  const isOpen = code === "waf_breaker_open";
  const retryAfter = Number(process.env.CHAT_CHALLENGE_RETRY_AFTER) || 30;
  if (!isOpen) noteChatChallenge();
  return {
    status: 503,
    retryAfter,
    body: {
      error: {
        message: isOpen
          ? "Qwen 上游繁忙，触发风控验证（被挤爆啦），請稍後重试 / Qwen chat challenge: upstream busy, retry later"
          : "Qwen 上游繁忙，触发风控验证（被挤爆啦），請稍後重试 / Qwen chat challenge: upstream busy, retry later",
        type: "upstream_waf_challenge",
        code: isOpen ? "waf_breaker_open" : "upstream_waf_challenge",
        retry_after_seconds: retryAfter,
      },
    },
  };
}

// ═══ ⚡ SSE 安全寫入 — 檢查 res.destroyed/res.writable/writableEnded，避免 client 斷線後 hang ═══
// 注意：res.write() 的錯誤（如 write after end）不會同步拋出，
// 而是經 internal _write 回調非同步發成 'error' 事件；
// 無 listener 會成為 uncaughtException（見 server.js）。故 res 必須掛 error handler，見 pipeUpstream。
const safeWrite = (res, data) => {
  try {
    if (!res.destroyed && !res.writableEnded && res.writable) {
      res.write(data);
      return true;
    }
  } catch {
    /* client 已斷線 */
  }
  return false;
};
const safeEnd = (res) => {
  try {
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch {}
};

/**
 * 設定回應頭
 * @param {object} res - Express 回應物件
 * @param {boolean} stream - 是否流式回應
 */
const setResponseHeaders = (res, stream) => {
  try {
    if (stream) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    } else {
      res.set({
        "Content-Type": "application/json",
      });
    }
  } catch (e) {
    logger.error("處理聊天請求時發生錯誤", "CHAT", "", e);
  }
};

const getImageMarkdownListFromDelta = (delta) => {
  // 常規聊天在觸發 image_gen_tool 時，僅使用 image_list 中用於展示的圖片連結
  const imageList = [];
  const displayImages = delta?.extra?.image_list || [];

  for (const item of displayImages) {
    if (item?.image) {
      imageList.push(`![image](${item.image})`);
    }
  }

  return imageList;
};

/**
 * 判斷 tool_choice 是否要求強制調用工具
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {boolean} 是否需要至少一次工具調用
 */
const requiresToolCall = (toolChoice) => {
  if (toolChoice === "required") return true;
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function?.name
  ) {
    return true;
  }
  return false;
};

/**
 * 建置 tool_choice=required 重試時追加的強約束提示
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {string} 重試提示詞
 */
const buildRequiredRetryHint = (toolChoice) => {
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.function?.name
  ) {
    return `You did not call any tool in your previous reply. You MUST now call the tool \`${toolChoice.function.name}\` using the <tool_call>...</tool_call> format and nothing else.`;
  }
  return "You did not call any tool in your previous reply. You MUST now call exactly one tool using the <tool_call>...</tool_call> format and nothing else.";
};

/**
 * 處理流式回應
 * @param {object} res - Express 回應物件
 * @param {object} response - 上游回應流
 * @param {boolean} enable_thinking - 是否啟用思考模式
 * @param {boolean} enable_web_search - 是否啟用網絡搜索
 * @param {object} requestBody - 原始請求體，用於提取prompt資訊
 * @param {object} [options] - 擴展選項
 * @param {boolean} [options.has_tools] - 是否啟用工具調用解析
 * @param {string|Object} [options.tool_choice] - OpenAI tool_choice 控制項
 */
/**
 * 安全累計 stats——任何異常都吞掉，不影響回應給客戶端
 * @param {Object} account - 目前帳戶物件（含 email）
 * @param {Object} usage - { prompt_tokens, completion_tokens }
 */
const attributeChatUsage = (account, usage) => {
  if (!account || !account.email || !usage) return;
  try {
    accountManager.accumulateStats(account.email, "chat", {
      input: Number(usage.prompt_tokens) || 0,
      output: Number(usage.completion_tokens) || 0,
    });
  } catch (e) {
    // 靜默——stats 累計失敗不應中斷回應
  }
};

const handleStreamResponse = async (
  res,
  response,
  enable_thinking,
  enable_web_search,
  requestBody = null,
  options = {},
) => {
  try {
    const message_id = generateUUID();
    let web_search_info = null;
    let thinking_start = false;
    let thinking_end = false;
    let emittedImageMarkdownSet = new Set();
    let pendingImageMarkdownList = [];

    const hasTools = !!options.has_tools;
    const toolChoice = options.tool_choice;
    const toolParser = hasTools ? createToolCallStreamParser() : null;

    // Token消耗量統計
    let totalTokens = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let completionContent = ""; // 收集完整的回覆內容用於token估算
    // 上游中途回 error 幀時的錯誤物件（非 WAF）。pipeUpstream 內捕獲，
    // 外層讀取後改寫為 SSE error 事件結束串流，不當正常 stop。
    let streamFailure = null;

    // ═══ <think> 標籤流解析狀態（fallback：當上游無 phase 欄位時使用） ═══
    let thinkActive = false;
    let thinkBuf = "";

    // 提取prompt文本用於token估算
    let promptText = "";
    if (requestBody && requestBody.messages) {
      promptText = requestBody.messages
        .map((msg) => {
          if (typeof msg.content === "string") {
            return msg.content;
          } else if (Array.isArray(msg.content)) {
            return msg.content.map((item) => item.text || "").join("");
          }
          return "";
        })
        .join("\n");
    }

    /**
     * 寫一個標準 OpenAI 文本增量（使用 safeWrite 避免 client 斷線 hang）
     * @param {string} text - 文本內容
     */
    const writeContentDelta = (text) => {
      if (!text) return;
      safeWrite(
        res,
        `data: ${JSON.stringify({
          id: `chatcmpl-${message_id}`,
          object: "chat.completion.chunk",
          created: Math.round(new Date().getTime() / 1000),
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    };

    /**
     * 寫一個 reasoning_content 增量（OpenAI 思考模式標準欄位）
     * @param {string} text - 思考文本內容
     */
    const writeReasoningDelta = (text) => {
      if (!text) return;
      safeWrite(
        res,
        `data: ${JSON.stringify({
          id: `chatcmpl-${message_id}`,
          object: "chat.completion.chunk",
          created: Math.round(new Date().getTime() / 1000),
          choices: [
            {
              index: 0,
              delta: { content: "", reasoning_content: text },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    };

    /**
     * 寫一個工具調用增量，按 OpenAI 規範分片（使用 safeWrite）
     *   1) 頭塊：包含 index/id/type 與 function.name + 空 arguments
     *   2) 多個參數塊：function.arguments 切片
     * @param {Array<Object>} calls - 已完成的工具調用列表
     */
    const writeToolCallsDelta = (calls) => {
      if (!calls || calls.length === 0) return;
      const ARG_CHUNK_SIZE = 32;

      for (const call of calls) {
        const headerDelta = {
          id: `chatcmpl-${message_id}`,
          object: "chat.completion.chunk",
          created: Math.round(new Date().getTime() / 1000),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: call.index,
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.function.name,
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        if (!safeWrite(res, `data: ${JSON.stringify(headerDelta)}\n\n`)) return;

        const argsString = call.function.arguments || "";
        for (
          let offset = 0;
          offset < argsString.length;
          offset += ARG_CHUNK_SIZE
        ) {
          const piece = argsString.slice(offset, offset + ARG_CHUNK_SIZE);
          const argDelta = {
            id: `chatcmpl-${message_id}`,
            object: "chat.completion.chunk",
            created: Math.round(new Date().getTime() / 1000),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: call.index,
                      function: { arguments: piece },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          if (!safeWrite(res, `data: ${JSON.stringify(argDelta)}\n\n`)) return;
        }
      }
    };

    /**
     * 輸出內容增量：若有工具解析器則先過濾 <tool_call> 塊
     * 2026-10-23 Fix：原本 toolParser 只宣告從未 push，
     * 串流模式下 <tool_call> XML 被當成純文字直接吐給 client
     * → 客戶端看不到 tool_calls，只能看到一堆 XML 字串。
     * @param {string} text - 內容增量
     */
    const emitContent = (text) => {
      if (!text) return;
      if (!toolParser) {
        writeContentDelta(text);
        return;
      }
      const r = toolParser.push(text);
      if (r.textDelta) writeContentDelta(r.textDelta);
      if (r.completedCalls.length > 0) writeToolCallsDelta(r.completedCalls);
    };

    /**
     * 處理一個 SSE data 段（已剝離 'data: ' 前綴）
     * @param {string} dataContent - 原始 data 段
     */
    const processSSEPayload = async (dataContent) => {
      const decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null;
      // 2026-10-25 Fix：PHASE-PROBE 原為 info 等級，每個 SSE chunk 都寫一行
      // → 單次長回覆可產生數千行日誌，磁碟 I/O 拖慢串流本身。
      // 改為 debug（僅 PROXY_LOG_LEVEL=debug 時輸出），並收斂為每 50 chunk 一次。
      if (process.env.PROBE_PHASE === "true") {
        try {
          const _d = decodeJson?.choices?.[0]?.delta;
          if (_d && _d.phase !== undefined)
            logger.debug(`[PHASE-PROBE] phase=${_d.phase}`, "CHAT");
        } catch {}
      }
      if (
        decodeJson === null ||
        !decodeJson.choices ||
        decodeJson.choices.length === 0
      ) {
        // ═══ Fix 2026-07-08: 識別上游業務錯誤（如 RateLimited） ═══
        if (
          decodeJson &&
          decodeJson.success === false &&
          decodeJson.data &&
          decodeJson.data.code
        ) {
          const code = decodeJson.data.code;
          const details = decodeJson.data.details || "";
          upstreamError =
            code === "RateLimited"
              ? new Error(`上游額度已達上限 (RateLimited): ${details}`)
              : new Error(`上游錯誤 (${code}): ${details}`);
          logger.error(
            `⬆️ 上游回傳${code === "RateLimited" ? "額度上限" : "錯誤"}: ${code} ${details}`,
            "CHAT",
          );
          receivedExplicitError = true;
        }
        return;
      }

      if (decodeJson.usage) {
        totalTokens = {
          prompt_tokens:
            decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
          completion_tokens:
            decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
          total_tokens:
            decodeJson.usage.total_tokens || totalTokens.total_tokens,
        };
      }

      const delta = decodeJson.choices[0].delta;

      if (delta && delta.name === "web_search") {
        web_search_info = delta.extra.web_search_info;
      }

      const imageMarkdownList = getImageMarkdownListFromDelta(delta);
      if (imageMarkdownList.length > 0) {
        const newImageMarkdownList = imageMarkdownList.filter(
          (item) => !emittedImageMarkdownSet.has(item),
        );

        if (thinking_start && !thinking_end) {
          for (const imageMarkdown of newImageMarkdownList) {
            if (!pendingImageMarkdownList.includes(imageMarkdown)) {
              pendingImageMarkdownList.push(imageMarkdown);
            }
          }
        } else if (newImageMarkdownList.length > 0) {
          const imageContent = `${newImageMarkdownList.join("\n\n")}\n\n`;
          completionContent += imageContent;
          newImageMarkdownList.forEach((item) =>
            emittedImageMarkdownSet.add(item),
          );
          writeContentDelta(imageContent);
        }
      }

      // ═══ 1) reasoning_content 先行（標準 OpenAI 思考模式欄位）═══
      if (delta.reasoning_content) {
        // Fix: 僅 outThink=true 時將 thinking 加入 content，避免泄漏到最終回應
        if (config.outThink) {
          completionContent += delta.reasoning_content;
        }
        if (!thinking_start) {
          thinking_start = true;
          if (web_search_info) {
            const rc = `${await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)}\n\n${delta.reasoning_content}`;
            if (config.outThink) writeReasoningDelta(rc);
          } else if (config.outThink) {
            writeReasoningDelta(delta.reasoning_content);
          }
        } else if (config.outThink) {
          writeReasoningDelta(delta.reasoning_content);
        }
        // 若同時有 content，繼續往下處理（罕見，但仍支援）
        if (!delta.content) return;
      }

      // ═══ 2) content 處理 ═══
      if (!delta.content) return;
      let rawContent = delta.content;
      completionContent += rawContent;

      // ═══ No phase — parse <think> tags from content (fallback for non-reasoning upstreams) ═══
      if (thinkActive) {
        const endIdx = rawContent.indexOf("</think>");
        if (endIdx >= 0) {
          thinkBuf += rawContent.slice(0, endIdx);
          if (config.outThink && thinkBuf.trim()) writeReasoningDelta(thinkBuf);
          thinkActive = false;
          thinkBuf = "";
          const rest = rawContent.slice(endIdx + 8);
          if (rest) {
            emitContent(rest);
            completionContent += rest;
          }
        } else {
          thinkBuf += rawContent;
        }
      } else {
        const startIdx = rawContent.indexOf("<think>");
        if (startIdx >= 0) {
          const preThink = rawContent.slice(0, startIdx);
          if (preThink) {
            emitContent(preThink);
            completionContent += preThink;
          }
          const postThink = rawContent.slice(startIdx + 7);
          if (postThink.includes("</think>")) {
            const endIdx2 = postThink.indexOf("</think>");
            const thinkText = postThink.slice(0, endIdx2);
            if (config.outThink && thinkText.trim())
              writeReasoningDelta(thinkText);
            const after = postThink.slice(endIdx2 + 8);
            if (after) {
              emitContent(after);
              completionContent += after;
            }
          } else {
            thinkBuf = postThink;
            thinkActive = true;
          }
        } else {
          // 純文字：若已有 reasoning 先關閉，輸出延遲的圖片
          if (thinking_start && !thinking_end) {
            thinking_end = true;
            if (pendingImageMarkdownList.length > 0) {
              const imgBlock = pendingImageMarkdownList.join("\n\n") + "\n\n";
              rawContent = imgBlock + rawContent;
              completionContent += imgBlock;
              pendingImageMarkdownList = [];
            }
          }
          emitContent(rawContent);
        }
      }
    };

    /**
     * 把一個上游回應流接入解析與轉發管線，等其結束
     * 內建 idle timeout（30s 無資料視為結束）與 keepalive
     * @param {object} upstreamResponse - axios stream 回應
     * @returns {Promise<void>} 流處理完成的 Promise
     */
    const pipeUpstream = (upstreamResponse) =>
      new Promise((resolve, reject) => {
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let idleTimer = null;
        let keepaliveTimer = null;
        let finished = false;
        let hasDataArrived = false;

        // ═══ Fix 3: client 斷線時立即清理上游，不等到下筆資料 ═══
        const cleanup = () => {
          if (finished) return;
          finished = true;
          clearTimers();
          res.removeListener("close", onResClose);
          upstreamResponse.removeListener("data", onData);
          upstreamResponse.removeListener("end", onEnd);
          upstreamResponse.removeListener("error", onError);
          try {
            upstreamResponse.destroy();
          } catch {}
        };

        const onResClose = () => {
          cleanup();
          resolve();
        };
        res.on("close", onResClose);
        // res 的 'error'（如 write after end / client 斷線）必須有 listener，
        // 否則成為未捕獲異常（server.js 只記錄不 exit，但會污染日誌並中斷轉發）
        res.on("error", (err) => {
          logger.warn(
            `回應串流錯誤（非致命）: ${err?.message || err}`,
            "CHAT",
          );
          cleanup();
          resolve();
        });

        const clearTimers = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        };

        // ═══ Fix 6: 增加間隔超時至 120s 避免模型產出中斷 ═══
        // 原 bug: 60s 間隔超時在複雜編碼任務時過早觸發，導致模型產出被截斷
        // 修復：調高至與 TTFB 一致 (120s)，給模型足夠時間生成長檔案
        const TTFB_TIMEOUT_MS = 120000;
        const INTER_CHUNK_TIMEOUT_MS = parseInt(
          process.env.CHAT_INTER_CHUNK_TIMEOUT_MS || "120000",
          10,
        );
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          const timeoutMs = hasDataArrived
            ? INTER_CHUNK_TIMEOUT_MS
            : TTFB_TIMEOUT_MS;
          idleTimer = setTimeout(() => {
            if (!finished) {
              const reason = hasDataArrived
                ? `串流間隔逾時 (${INTER_CHUNK_TIMEOUT_MS / 1000}s)`
                : `上游首字節逾時 (${TTFB_TIMEOUT_MS / 1000}s)`;
              logger.warn(reason + "，強制結束", "CHAT");
              cleanup();
              resolve();
            }
          }, timeoutMs);
        };

        // 15 秒 keepalive 心跳（維持 client 連線）
        // 原 bug：res.write() 的 write-after-end 是非同步 error 事件，try/catch 攔不住
        const KEEPALIVE_INTERVAL_MS = 15000;
        keepaliveTimer = setInterval(() => {
          safeWrite(res, ": keepalive\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        resetIdle();

        const onData = async (chunk) => {
          if (finished) return;
          // ═══ Fix 3: 檢查 client 是否已斷線，斷線則清理上游 stream ═══
          if (res.destroyed) {
            cleanup();
            resolve();
            return;
          }
          if (!hasDataArrived) hasDataArrived = true; // 首 byte 已抵達，切換至間隔超時
          resetIdle(); // 有資料就重設 idle timer

          const decodeText = decoder.decode(chunk, { stream: true });
          buffer += decodeText;

          const chunks = [];
          let startIndex = 0;

          while (true) {
            const dataStart = buffer.indexOf("data: ", startIndex);
            if (dataStart === -1) break;
            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break;
            const dataChunk = buffer.substring(dataStart, dataEnd).trim();
            chunks.push(dataChunk);
            startIndex = dataEnd + 2;
          }

          if (startIndex > 0) {
            buffer = buffer.substring(startIndex);
          }

          for (const item of chunks) {
            try {
              const raw = item.replace("data: ", "");
              // ═══ Fix 2026-10-18: Qwen 白天尖峰會回 HTTP 200 + challenge 幀
              // {ret:['FAIL_SYS_USER_VALIDATE','...被挤爆啦...']}，沒有 choices。
              // 舊邏輯只認 HTTP 403/503，challenge 幀被靜默吞掉 → 表現為「上游空白」。
              // 這裡先偵測，明確丟出讓 client 收到 503 + Retry-After。
              if (raw !== "[DONE]") {
                let payload = null;
                try {
                  payload = JSON.parse(raw);
                } catch (_) {
                  payload = null;
                }
                if (payload) assertNoUpstreamFailure(payload);
              }
              await processSSEPayload(raw);
            } catch (error) {
              if (isWafChallengeError(error)) {
                logger.warn(
                  `[WAF] ${error.message}（熔斷 strikes=${chatBreakerState().strikes}）`,
                  "CHAT",
                );
                // 交給外層 reject，讓 client 拿到 503 + Retry-After
                cleanup();
                reject(error);
                return;
              }
              logger.error("流式資料處理錯誤", "CHAT", "", error);
              // ═══ Fix 2026-11-05: 上游錯誤幀不再靜默吞掉 ═══
              // 舊邏輯只記 log 然後繼續吃 chunk：client（opencode）收到殘缺／空串流，
              // 結尾仍被當正常 stop 存檔，污染對話歷史與壓縮摘要。
              // 改為停止讀取上游，把錯誤記到 streamFailure，由外層寫 SSE error 幀結束。
              streamFailure = error;
              cleanup();
              resolve();
            }
          }
        };
        upstreamResponse.on("data", onData);

        const onEnd = () => {
          cleanup();
          resolve();
        };
        upstreamResponse.on("end", onEnd);

        const onError = (err) => {
          cleanup();
          reject(err);
        };
        upstreamResponse.on("error", onError);
      });

    await pipeUpstream(response);

    if (streamFailure) {
      // 上游中途回錯誤幀：寫 OpenAI 標準 SSE error 事件給 client，再 [DONE] 結束。
      // opencode 的 Zod union 可解析 error 物件（lesson 2026-11-04-2020），
      // 本回合明確標記失敗，殘缺內容不會當正常 stop 存檔、不污染 compaction。
      safeWrite(
        res,
        `data: ${JSON.stringify({
          error: {
            message: streamFailure?.message || "Upstream error",
            type: "upstream_error",
            code: streamFailure?.code || "upstream_error",
          },
        })}\n\n`,
      );
      safeWrite(res, `data: [DONE]\n\n`);
      safeEnd(res);
      return;
    }

    // tool_choice="required" 強校驗：未觸發任何工具調用則追加更強提示重試一次
    if (
      hasTools &&
      toolParser &&
      !toolParser.hasEmittedAnyCall() &&
      requiresToolCall(toolChoice)
    ) {
      const retryHint = buildRequiredRetryHint(toolChoice);
      const retryBody = {
        ...requestBody,
        messages: [
          ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
          { role: "system", content: retryHint },
        ],
      };
      logger.warning?.(
        "tool_choice=required 首次未觸發工具調用，進行一次重試",
        "CHAT",
      );
      try {
        const retryResp = await sendChatRequest(retryBody);
        if (retryResp.status && retryResp.response) {
          await pipeUpstream(retryResp.response);
        }
      } catch (e) {
        logger.error("required 模式重試失敗", "CHAT", "", e);
      }
    }

    // flush 工具調用解析器中的殘留內容
    if (toolParser) {
      const tail = toolParser.flush();
      if (tail.textDelta) writeContentDelta(tail.textDelta);
      if (tail.completedCalls.length > 0)
        writeToolCallsDelta(tail.completedCalls);
    }

    // 處理最終的搜索資訊
    if (
      (config.outThink === false || !enable_thinking) &&
      web_search_info &&
      config.searchInfoMode === "text"
    ) {
      const webSearchTable = await accountManager.generateMarkdownTable(
        web_search_info,
        "text",
      );
      writeContentDelta(`\n\n---\n${webSearchTable}`);
    }

    // 計算最終的token使用量
    if (
      totalTokens.prompt_tokens === 0 &&
      totalTokens.completion_tokens === 0
    ) {
      totalTokens = createUsageObject(
        requestBody?.messages || promptText,
        completionContent,
        null,
      );
      logger.info(
        `流式使用tiktoken計算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    } else {
      // ═══ Fix 12: 上游回傳空內容時記錄除錯資訊 ═══
      const _hasStreamContent =
        totalTokens.completion_tokens > 0 ||
        completionContent.trim().length > 0;
      if (
        !_hasStreamContent &&
        (totalTokens.prompt_tokens > 0 || promptText.length > 0)
      ) {
        logger.warn(
          `⬆️ [串流] 上游回傳空內容: model=${requestBody?.model || "?"} prompt_tokens=${totalTokens.prompt_tokens} completion_tokens=${totalTokens.completion_tokens} 請檢查模型名稱與 Token 權限`,
          "CHAT",
        );
      }
      logger.info(
        `流式使用上游真實Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    }

    totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0);
    totalTokens.completion_tokens = Math.max(
      0,
      totalTokens.completion_tokens || 0,
    );
    totalTokens.total_tokens =
      totalTokens.prompt_tokens + totalTokens.completion_tokens;

    // Daily stats 累計——一次性歸屬到主請求帳戶
    // 注：tool_choice=required retry 走的可能是另一個帳戶，但 retry 路徑罕見，
    // 全歸屬主帳戶是可接受的精度損失（PR #3wg.1 epic notes 已記）
    attributeChatUsage(options.currentAccount, totalTokens);

    const finishReason =
      toolParser && toolParser.hasEmittedAnyCall() ? "tool_calls" : "stop";
    safeWrite(
      res,
      `data: ${JSON.stringify({
        id: `chatcmpl-${message_id}`,
        object: "chat.completion.chunk",
        created: Math.round(new Date().getTime() / 1000),
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      })}\n\n`,
    );

    safeWrite(
      res,
      `data: ${JSON.stringify({
        id: `chatcmpl-${message_id}`,
        object: "chat.completion.chunk",
        created: Math.round(new Date().getTime() / 1000),
        choices: [],
        usage: totalTokens,
      })}\n\n`,
    );

    safeWrite(res, `data: [DONE]\n\n`);
    safeEnd(res);
  } catch (error) {
    // ═══ Fix 2026-10-18: chat challenge → 503 + Retry-After（可重試的過載）═══
    // 舊邏輯一律 500「Service error」，client 不知道何時重試 → 立刻重試 hammer Qwen。
    // 對齊原作者 81b75ad：503 + Retry-After: 30，訊息說明上游繁忙。
    if (isWafChallengeError(error)) {
      const retryAfter = Number(error.retryAfter) || 30;
      logger.warn(
        `[WAF] 回 503 + Retry-After=${retryAfter}（Qwen 尖峰風控，稍後重試）`,
        "CHAT",
      );
      if (!res.headersSent) {
        try {
          res.set("Retry-After", String(retryAfter));
          res.status(503).json({
            error: {
              message: error.message,
              type: "upstream_waf_challenge",
              code: error.code,
              retry_after_seconds: retryAfter,
            },
          });
        } catch (_) {}
      } else {
        // SSE 已開始：寫 OpenAI 標準 error 幀 + [DONE] 收尾，
        // 不能靜默 return（client 會一直等，且殘缺串流被當正常結束存檔）
        safeWrite(
          res,
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "upstream_waf_challenge",
              code: error.code || "upstream_waf_challenge",
              retry_after_seconds: retryAfter,
            },
          })}\n\n`,
        );
        safeWrite(res, `data: [DONE]\n\n`);
        safeEnd(res);
      }
      return;
    }
    logger.error("聊天處理錯誤", "CHAT", "", error);
    // ═══ Fix 10: 若 headers 已送出，不應再 res.status(500) ═══
    // 原 bug: SSE 串流開始後，catch 嘗試發送 JSON error response，
    // 但 content-type 已是 text/event-stream，發送會失敗且客戶端看到不完整串流
    if (!res.headersSent) {
      try {
        res.status(500).json({ error: "Service error" });
      } catch (_) {}
    } else {
      // SSE 已開始：補寫 error 幀 + [DONE] 收尾，避免 client 掛死
      safeWrite(
        res,
        `data: ${JSON.stringify({
          error: {
            message: error?.message || "Service error",
            type: "upstream_error",
            code: "upstream_error",
          },
        })}\n\n`,
      );
      safeWrite(res, `data: [DONE]\n\n`);
      safeEnd(res);
    }
  }
};

/**
 * 處理非流式回應（從流式資料累積完整回應）
 * @param {object} res - Express 回應物件
 * @param {object} response - 上游回應流
 * @param {boolean} enable_thinking - 是否啟用思考模式
 * @param {boolean} enable_web_search - 是否啟用網絡搜索
 * @param {string} model - 模型名稱
 * @param {object} requestBody - 原始請求體，用於提取prompt資訊
 * @param {object} [options] - 擴展選項
 * @param {boolean} [options.has_tools] - 是否啟用工具調用解析
 */
const handleNonStreamResponse = async (
  res,
  response,
  enable_thinking,
  enable_web_search,
  model,
  requestBody = null,
  options = {},
) => {
  try {
    let fullContent = ""; // only content + images, NO reasoning_content
    let reasoningContent = "";
    let contentForToken = ""; // for token estimation (includes reasoning tokens)
    let web_search_info = null;
    let thinking_start = false;
    let thinking_end = false;
    let appendedImageMarkdownSet = new Set();
    let pendingImageMarkdownList = [];

    const hasTools = !!options.has_tools;
    const toolChoice = options.tool_choice;

    // Token消耗量統計
    let totalTokens = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // 提取prompt文本用於token估算
    let promptText = "";
    if (requestBody && requestBody.messages) {
      promptText = requestBody.messages
        .map((msg) => {
          if (typeof msg.content === "string") {
            return msg.content;
          } else if (Array.isArray(msg.content)) {
            return msg.content.map((item) => item.text || "").join("");
          }
          return "";
        })
        .join("\n");
    }

    /**
     * 把一個上游回應流讀完並累積到 fullContent
     * 內建 idle timeout（30s 無資料視為結束）
     * @param {object} upstreamResponse - axios stream 回應
     * @returns {Promise<void>} 流處理完成的 Promise
     */
    const accumulateUpstream = (upstreamResponse) =>
      new Promise((resolve, reject) => {
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let idleTimer = null;
        let finished = false;
        let hasDataArrived = false;
        let upstreamError = null;
        let receivedExplicitError = false;

        // ═══ Fix 3: client 斷線時立即清理上游（非串流也適用） ═══
        const cleanup = () => {
          if (finished) return;
          finished = true;
          clearIdle();
          res.removeListener("close", onResClose);
          upstreamResponse.removeListener("data", onData);
          upstreamResponse.removeListener("end", onEnd);
          upstreamResponse.removeListener("error", onError);
          try {
            upstreamResponse.destroy();
          } catch {}
        };

        const onResClose = () => {
          cleanup();
          resolve();
        };
        res.on("close", onResClose);
        // res 的 'error'（如 write after end / client 斷線）必須有 listener，
        // 否則成為未捕獲異常（server.js 只記錄不 exit，但會污染日誌並中斷轉發）
        res.on("error", (err) => {
          logger.warn(
            `回應串流錯誤（非致命）: ${err?.message || err}`,
            "CHAT",
          );
          cleanup();
          resolve();
        });

        const clearIdle = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };

        // ═══ 兩段式超時（同 pipeUpstream，INTER_CHUNK 120s） ═══
        const TTFB_TIMEOUT_MS = 120000;
        const INTER_CHUNK_TIMEOUT_MS = parseInt(
          process.env.CHAT_INTER_CHUNK_TIMEOUT_MS || "120000",
          10,
        );
        const resetIdle = () => {
          clearIdle();
          const timeoutMs = hasDataArrived
            ? INTER_CHUNK_TIMEOUT_MS
            : TTFB_TIMEOUT_MS;
          idleTimer = setTimeout(() => {
            if (!finished) {
              const reason = hasDataArrived
                ? `非流式間隔逾時 (${INTER_CHUNK_TIMEOUT_MS / 1000}s)`
                : `上游首字節逾時 (${TTFB_TIMEOUT_MS / 1000}s)`;
              logger.warn(reason + "，強制結束", "CHAT");
              cleanup();
              resolve();
            }
          }, timeoutMs);
        };

        resetIdle();

        const onData = async (chunk) => {
          if (finished) return;
          // ═══ Fix 3: 檢查 client 是否已斷線 ═══
          if (res.destroyed) {
            cleanup();
            resolve();
            return;
          }
          if (!hasDataArrived) hasDataArrived = true;
          resetIdle();

          const decodeText = decoder.decode(chunk, { stream: true });
          buffer += decodeText;

          const chunks = [];
          let startIndex = 0;

          while (true) {
            const dataStart = buffer.indexOf("data: ", startIndex);
            if (dataStart === -1) break;
            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break;
            const dataChunk = buffer.substring(dataStart, dataEnd).trim();
            chunks.push(dataChunk);
            startIndex = dataEnd + 2;
          }

          if (startIndex > 0) {
            buffer = buffer.substring(startIndex);
          }

          for (const item of chunks) {
            try {
              const dataContent = item.replace("data: ", "");
              const decodeJson = isJson(dataContent)
                ? JSON.parse(dataContent)
                : null;
              if (
                decodeJson === null ||
                !decodeJson.choices ||
                decodeJson.choices.length === 0
              ) {
                // ═══ Fix 2026-07-08: 識別上游業務錯誤（如 RateLimited） ═══
                // 上游 success:false 且 data.code 為錯誤碼時，記錄明確錯誤，
                // 避免被當成「空內容」靜默丟棄，讓用戶誤以為是對話停滯。
                if (
                  decodeJson &&
                  decodeJson.success === false &&
                  decodeJson.data &&
                  decodeJson.data.code
                ) {
                  const code = decodeJson.data.code;
                  const details = decodeJson.data.details || "";
                  if (code === "RateLimited") {
                    upstreamError = new Error(
                      `上游額度已達上限 (RateLimited): ${details}`,
                    );
                    logger.error(`⬆️ 上游回傳額度上限: ${details}`, "CHAT");
                  } else {
                    upstreamError = new Error(`上游錯誤 (${code}): ${details}`);
                    logger.error(`⬆️ 上游回傳錯誤: ${code} ${details}`, "CHAT");
                  }
                  // 標記已收到明確錯誤，結束累積（但仍繼續讀完流避免掛起）
                  receivedExplicitError = true;
                }
                continue;
              }

              if (decodeJson.usage) {
                totalTokens = {
                  prompt_tokens:
                    decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                  completion_tokens:
                    decodeJson.usage.completion_tokens ||
                    totalTokens.completion_tokens,
                  total_tokens:
                    decodeJson.usage.total_tokens || totalTokens.total_tokens,
                };
              }

              const delta = decodeJson.choices[0].delta;

              if (delta && delta.name === "web_search") {
                web_search_info = delta.extra.web_search_info;
              }

              const imageMarkdownList = getImageMarkdownListFromDelta(delta);
              if (imageMarkdownList.length > 0) {
                const newImageMarkdownList = imageMarkdownList.filter(
                  (it) => !appendedImageMarkdownSet.has(it),
                );

                if (thinking_start && !thinking_end) {
                  for (const imageMarkdown of newImageMarkdownList) {
                    if (!pendingImageMarkdownList.includes(imageMarkdown)) {
                      pendingImageMarkdownList.push(imageMarkdown);
                    }
                  }
                } else if (newImageMarkdownList.length > 0) {
                  const imgBlock = `${newImageMarkdownList.join("\n\n")}\n\n`;
                  fullContent += imgBlock;
                  contentForToken += imgBlock;
                  newImageMarkdownList.forEach((it) =>
                    appendedImageMarkdownSet.add(it),
                  );
                }
              }

              if (!delta || (!delta.content && !delta.reasoning_content))
                continue;

              // ═══ 1) reasoning_content 先行 ═══
              if (delta.reasoning_content) {
                contentForToken += delta.reasoning_content; // for token estimation
                if (!thinking_start) {
                  thinking_start = true;
                  if (web_search_info) {
                    const table = await accountManager.generateMarkdownTable(
                      web_search_info,
                      config.searchInfoMode,
                    );
                    reasoningContent += table + "\n\n";
                  }
                }
                reasoningContent += delta.reasoning_content;
                if (!delta.content) continue;
              }

              // ═══ 2) content ═══
              let rawContent = delta.content;
              if (!rawContent) continue;

              // 從 reasoning 切換到 content 時，輸出延遲的圖片
              if (!thinking_end && thinking_start) {
                thinking_end = true;
                if (pendingImageMarkdownList.length > 0) {
                  const pendingImg =
                    pendingImageMarkdownList.join("\n\n") + "\n\n";
                  fullContent += pendingImg;
                  contentForToken += pendingImg;
                  pendingImageMarkdownList.forEach((it) =>
                    appendedImageMarkdownSet.add(it),
                  );
                  pendingImageMarkdownList = [];
                }
              }
              fullContent += rawContent;
              contentForToken += rawContent;
            } catch (error) {
              logger.error("非流式資料處理錯誤", "CHAT", "", error);
            }
          }
        };
        upstreamResponse.on("data", onData);

        const onEnd = () => {
          cleanup();
          resolve();
        };
        upstreamResponse.on("end", onEnd);

        const onError = (err) => {
          cleanup();
          reject(err);
        };
        upstreamResponse.on("error", onError);
      });

    await accumulateUpstream(response);

    // ═══ fallback: <think> 標籤提取（僅上游無 reasoning_content 時使用） ═══
    // Fix: 始終從 content 中移除 <think> 標籤，避免 thinking 混入最終回應
    // outThink=true 時同時保留到 reasoning_content 欄位
    if (!reasoningContent && fullContent.includes("<think>")) {
      const cleaned = fullContent.replace(
        /<think>[\s\S]*?<\/think>/g,
        (match) => {
          const thinkText = match.replace(/<\/?think>/g, "").trim();
          if (thinkText && config.outThink)
            reasoningContent += thinkText + "\n";
          return "";
        },
      );
      fullContent = cleaned.trim();
    }

    // 工具調用解析：從 fullContent 抽取 <tool_call> 塊
    let assistantContent = fullContent;
    let toolCalls = [];
    if (hasTools) {
      const parsed = parseToolCallsFromText(fullContent);
      assistantContent = parsed.cleanedText;
      toolCalls = parsed.toolCalls;
    }

    // tool_choice="required" 強校驗：未觸發則重試一次
    if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)) {
      const retryHint = buildRequiredRetryHint(toolChoice);
      const retryBody = {
        ...requestBody,
        messages: [
          ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
          { role: "system", content: retryHint },
        ],
      };
      logger.warning?.(
        "tool_choice=required 首次未觸發工具調用，進行一次重試",
        "CHAT",
      );
      try {
        const retryResp = await sendChatRequest(retryBody);
        if (retryResp.status && retryResp.response) {
          const before = fullContent;
          await accumulateUpstream(retryResp.response);
          const retriedText = fullContent.slice(before.length);
          const parsedRetry = parseToolCallsFromText(retriedText);
          if (parsedRetry.toolCalls.length > 0) {
            toolCalls = parsedRetry.toolCalls;
            assistantContent = parseToolCallsFromText(fullContent).cleanedText;
          }
        }
      } catch (e) {
        logger.error("required 模式重試失敗", "CHAT", "", e);
      }
    }

    // 處理最終的搜索資訊
    if (
      (config.outThink === false || !enable_thinking) &&
      web_search_info &&
      config.searchInfoMode === "text"
    ) {
      const webSearchTable = await accountManager.generateMarkdownTable(
        web_search_info,
        "text",
      );
      assistantContent += `\n\n---\n${webSearchTable}`;
    }

    // 計算最終的token使用量
    if (
      totalTokens.prompt_tokens === 0 &&
      totalTokens.completion_tokens === 0
    ) {
      totalTokens = createUsageObject(
        requestBody?.messages || promptText,
        contentForToken,
        null,
      );
      logger.info(
        `非流式使用tiktoken計算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    } else {
      // ═══ Fix 12: 上游回傳空內容時記錄除錯資訊 ═══
      // 當上游 API 回傳 HTTP 200 但 completion=0 且 prompt>0，
      // 表示 Qwen API 成功接收請求但回傳空白回應（可能模型不可用、Token 無權限、WAF 靜默阻擋）
      const _upstreamHasContent =
        totalTokens.completion_tokens > 0 ||
        contentForToken.trim().length > 0 ||
        !!(toolCalls?.length > 0);
      if (
        !_upstreamHasContent &&
        (totalTokens.prompt_tokens > 0 || promptText.length > 0)
      ) {
        logger.warn(
          `⬆️ 上游回傳空內容: model=${model} prompt_tokens=${totalTokens.prompt_tokens} completion_tokens=${totalTokens.completion_tokens} 請檢查模型名稱與 Token 權限`,
          "CHAT",
        );
      }
      logger.info(
        `非流式使用上游真實Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    }

    totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0);
    totalTokens.completion_tokens = Math.max(
      0,
      totalTokens.completion_tokens || 0,
    );
    totalTokens.total_tokens =
      totalTokens.prompt_tokens + totalTokens.completion_tokens;

    // Daily stats 累計——一次性歸屬到主請求帳戶（同 stream 分支註釋）
    attributeChatUsage(options.currentAccount, totalTokens);

    const assistantMessage = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }
    // 當 OUTPUT_THINK=true 且上游有思考內容時，輸出 OpenAI 標準 reasoning_content 欄位
    if (config.outThink && reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent.trimEnd();
    }

    const bodyTemplate = {
      id: `chatcmpl-${generateUUID()}`,
      object: "chat.completion",
      created: Math.round(new Date().getTime() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: assistantMessage,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: totalTokens,
    };
    res.json(bodyTemplate);
  } catch (error) {
    // ═══ Fix 2026-07-08: error.message 直接嵌入 log 字串，避免 JSON.stringify(error) 空物件 ═══
    logger.error(
      `非流式聊天處理錯誤: ${error?.message || error}`,
      "CHAT",
      "",
      error,
    );
    res.status(500).json({
      error: "Service error",
    });
  }
};

/**
 * 主要的聊天完成處理函式
 * @param {object} req - Express 請求物件
 * @param {object} res - Express 回應物件
 */
const handleChatCompletion = async (req, res) => {
  res.on("error", (e) => { /* 防止 write after end 成為未捕獲異常 */ });
  const { stream, model } = req.body;

  const enable_thinking = req.enable_thinking;
  const enable_web_search = req.enable_web_search;

  try {
    const response_data = await sendChatRequest(req.body);

    if (!response_data.status || !response_data.response) {
      // ═══ Fix 2026-10-18: challenge / 熔斷 → 503 + Retry-After（可重試的過載）═══
      // 舊邏輯一律 500「Request failed」，client 不知道是暫時性問題還是永久故障，
      // 只能立刻重試 → 在被風控的 IP 上 hammer Qwen，讓封鎖越拖越久。
      const waf = buildUpstreamErrorResponse(response_data.error);
      if (waf) {
        res.set("Retry-After", String(waf.retryAfter));
        res.status(waf.status).json(waf.body);
        return;
      }
      res.status(500).json({
        error: "Request failed",
      });
      return;
    }

    if (stream) {
      setResponseHeaders(res, true);
      await handleStreamResponse(
        res,
        response_data.response,
        enable_thinking,
        enable_web_search,
        req.body,
        {
          has_tools: req.has_tools,
          tool_choice: req.tool_choice,
          currentAccount: response_data.currentAccount,
        },
      );
    } else {
      setResponseHeaders(res, false);
      await handleNonStreamResponse(
        res,
        response_data.response,
        enable_thinking,
        enable_web_search,
        model,
        req.body,
        {
          has_tools: req.has_tools,
          tool_choice: req.tool_choice,
          currentAccount: response_data.currentAccount,
        },
      );
    }
  } catch (error) {
    // ═══ Fix 2026-07-08: error.message 直接嵌入 log 字串 ═══
    logger.error(`聊天處理錯誤: ${error?.message || error}`, "CHAT", "", error);
    if (!res.headersSent) {
      try {
        res.status(500).json({
          error: "Invalid token, request failed",
        });
      } catch (_) {}
    } else {
      // SSE 已開始：補寫 error 幀 + [DONE] 收尾，避免 client 掛死
      safeWrite(
        res,
        `data: ${JSON.stringify({
          error: {
            message: error?.message || "Service error",
            type: "upstream_error",
            code: "upstream_error",
          },
        })}\n\n`,
      );
      safeWrite(res, `data: [DONE]\n\n`);
      safeEnd(res);
    }
  }
};

module.exports = {
  handleChatCompletion,
  handleStreamResponse,
  handleNonStreamResponse,
  setResponseHeaders,
};
