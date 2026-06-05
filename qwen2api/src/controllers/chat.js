const { isJson, generateUUID } = require("../utils/tools.js");
const {
  countTokens,
  createUsageObject,
} = require("../utils/precise-tokenizer.js");
const { sendChatRequest, getUpstreamHealth } = require("../utils/request.js");
const {
  createToolCallStreamParser,
  parseToolCallsFromText,
} = require("../utils/tool-prompt.js");
const accountManager = require("../utils/account.js");
const config = require("../config/index.js");
const axios = require("axios");
const { logger } = require("../utils/logger");

// ─── 全域併發限制：保護 waf-proxy 不被大量請求淹沒 ───
const MAX_CONCURRENT_OUTGOING = parseInt(
  process.env.QWEN_MAX_CONCURRENT || "2",
  10,
);
let outgoingActive = 0;
const outgoingQueue = [];

function acquireOutgoing() {
  return new Promise((resolve) => {
    if (outgoingActive < MAX_CONCURRENT_OUTGOING) {
      outgoingActive++;
      resolve();
    } else {
      outgoingQueue.push(resolve);
    }
  });
}

function releaseOutgoing() {
  if (outgoingQueue.length > 0) {
    const next = outgoingQueue.shift();
    next();
  } else {
    outgoingActive--;
  }
}

/**
 * 設定響應頭
 * @param {object} res - Express 響應物件
 * @param {boolean} stream - 是否流式響應
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
 * 判斷 tool_choice 是否要求強制呼叫工具
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {boolean} 是否需要至少一次工具呼叫
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
 * 構建 tool_choice=required 重試時追加的強約束提示
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
 * 處理流式響應
 * @param {object} res - Express 響應物件
 * @param {object} response - 上游響應流
 * @param {boolean} enable_thinking - 是否啟用思考模式
 * @param {boolean} enable_web_search - 是否啟用網路搜尋
 * @param {object} requestBody - 原始請求體，用於提取prompt資訊
 * @param {object} [options] - 擴充套件選項
 * @param {boolean} [options.has_tools] - 是否啟用工具呼叫解析
 * @param {string|Object} [options.tool_choice] - OpenAI tool_choice 控制項
 */
const handleStreamResponse = async (
  res,
  response,
  enable_thinking,
  enable_web_search,
  requestBody = null,
  options = {},
) => {
  // P0-2: 客戶端斷線偵測
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
      logger.info("客戶端斷線，中止上游請求", "CHAT");
    }
  });

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
    // P0: 移除 completionContent，改用增量 token 計數器以避免記憶體洩漏
    let completionTokenCount = 0;

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
     * 寫一個標準 OpenAI 文本增量（content）
     * @param {string} text - 文本內容
     */
    const writeContentDelta = (text) => {
      if (!text) return;
      res.write(
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
     * 寫一個 reasoning 增量（OpenAI 標準 reasoning_content）
     * 讓 AI SDK 正確識別為 reasoning part，而非一般文字
     * @param {string} text - reasoning 內容
     */
    const writeReasoningDelta = (text) => {
      if (!text) return;
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${message_id}`,
          object: "chat.completion.chunk",
          created: Math.round(new Date().getTime() / 1000),
          choices: [
            {
              index: 0,
              delta: { reasoning_content: text },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    };

    /**
     * 寫一個工具呼叫增量，按 OpenAI 規範分片：
     *   1) 頭塊：包含 index/id/type 與 function.name + 空 arguments
     *   2) 多個引數塊：function.arguments 切片
     * @param {Array<Object>} calls - 已完成的工具呼叫列表
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
        res.write(`data: ${JSON.stringify(headerDelta)}\n\n`);

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
          res.write(`data: ${JSON.stringify(argDelta)}\n\n`);
        }
      }
    };

    /**
     * 處理一個 SSE data 段（已剝離 'data: ' 字首）
     * @param {string} dataContent - 原始 data 段
     */
    const processSSEPayload = async (dataContent) => {
      const decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null;
      if (
        decodeJson === null ||
        !decodeJson.choices ||
        decodeJson.choices.length === 0
      ) {
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
          // P0: 增量計算 token
          completionTokenCount += countTokens(imageContent);
          newImageMarkdownList.forEach((item) =>
            emittedImageMarkdownSet.add(item),
          );
          writeContentDelta(imageContent);
        }
      }

      if (
        !delta ||
        !delta.content ||
        (delta.phase !== "think" && delta.phase !== "answer")
      ) {
        return;
      }

      let content = delta.content;

      if (delta.phase === "think") {
        if (!thinking_start) {
          thinking_start = true;
          // 在 reasoning 開頭嵌入 web_search 資訊
          if (web_search_info) {
            writeReasoningDelta(
              `\n\n${await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)}\n\n`,
            );
          }
        }
        // P0: 增量計算 token，避免儲存完整字串
        completionTokenCount += countTokens(content);
        writeReasoningDelta(content);
        return; // thinking 內容只走 reasoning_content，不走 content
      }

      // delta.phase === "answer"
      if (!thinking_end && thinking_start) {
        thinking_end = true;
        // 切換到 answer 時，flush 在 thinking 期間累積的圖片
        if (pendingImageMarkdownList.length > 0) {
          const pendingImageContent = `${pendingImageMarkdownList.join("\n\n")}\n\n`;
          completionTokenCount += countTokens(pendingImageContent);
          pendingImageMarkdownList.forEach((item) =>
            emittedImageMarkdownSet.add(item),
          );
          pendingImageMarkdownList = [];
          writeContentDelta(pendingImageContent);
        }
      }

      completionTokenCount += countTokens(content);

      if (toolParser) {
        const parsed = toolParser.push(content);
        if (parsed.textDelta) writeContentDelta(parsed.textDelta);
        if (parsed.completedCalls.length > 0)
          writeToolCallsDelta(parsed.completedCalls);
      } else {
        writeContentDelta(content);
      }
    };

    /**
     * 把一個上游響應流接入解析與轉發管線，等其結束
     * @param {object} upstreamResponse - axios stream 響應
     * @param {AbortController} [abortController] - 客戶端斷線中止控制器
     * @returns {Promise<void>} 流處理完成的 Promise
     */
    const pipeUpstream = (upstreamResponse, abortController = null) =>
      new Promise((resolve, reject) => {
        const decoder = new TextDecoder("utf-8");
        // P1: 改用 Buffer 物件避免字串拼接記憶體洩漏
        let buffer = Buffer.alloc(0);
        let processing = false;
        const queue = [];
        const MAX_QUEUE_SIZE = 3000; // P0-1: 降低佇列上限，更早觸發背壓保護
        const DROP_THRESHOLD = 2000; // P2: 佇列達到 66% 時開始丟棄舊數據
        let isPaused = false;
        let drainTimer = null; // P21: 防止 resume 後再次快速填滿

        // 非同步處理佇列，避免阻塞 stream data 事件
        const processQueue = async () => {
          if (processing || queue.length === 0) return;
          processing = true;
          try {
            // P22: 批次處理，避免單個 chunk 處理過慢導致整體卡住
            const batchSize = Math.min(queue.length, 50);
            for (let i = 0; i < batchSize; i++) {
              const item = queue.shift();
              if (!item) break;
              try {
                await processSSEPayload(item);
              } catch (error) {
                logger.error("流式資料處理錯誤", "CHAT", "", error);
              }
            }
          } finally {
            processing = false;
            // P12: 若佇列低於閾值且曾暫停，立即恢復上游
            if (isPaused && queue.length < DROP_THRESHOLD) {
              isPaused = false;
              upstreamResponse.resume();
              logger.info(
                `🔄 佇列降至 ${queue.length} (<${DROP_THRESHOLD})，恢復上游 stream`,
                "CHAT",
              );
              // P21: 設定冷卻時間，避免瞬間再次填滿
              if (drainTimer) clearTimeout(drainTimer);
              drainTimer = setTimeout(() => {
                drainTimer = null;
              }, 2000);
            }
            if (queue.length > 0) {
              setImmediate(processQueue);
            }
          }
        };

        upstreamResponse.on("data", (chunk) => {
          // P0-2: 客戶端斷線時立即中止
          if (abortController?.signal.aborted) {
            upstreamResponse.destroy();
            return;
          }

          // P1: 使用 Buffer.concat 避免字串拼接
          buffer = Buffer.concat([buffer, chunk]);

          let startIndex = 0;
          while (true) {
            const dataStart = buffer.indexOf("data: ", startIndex);
            if (dataStart === -1) break;
            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break;
            // P1: 使用 subarray 避免底層記憶體共享
            const dataChunk = buffer
              .subarray(dataStart + 6, dataEnd)
              .toString("utf-8")
              .trim();
            if (dataChunk) {
              // P2: 背壓控制 - 佇列滿時暫停上游而非丟棄數據
              // 丟棄數據會導致客戶端收到不完整回應，改為暫停上游等待消費
              if (queue.length >= MAX_QUEUE_SIZE && !isPaused) {
                isPaused = true;
                upstreamResponse.pause();
                logger.warn(
                  `⏸️ 佇列達上限 ${MAX_QUEUE_SIZE}，暫停上游等待消費`,
                  "CHAT",
                );
              }
              queue.push(dataChunk);
            }
            startIndex = dataEnd + 2;
          }

          if (startIndex > 0) {
            buffer = buffer.subarray(startIndex);
          }

          // P1: 定期重置 buffer 避免長期持有大塊記憶體
          if (buffer.length > 1024 * 1024) {
            buffer = Buffer.from(buffer);
          }

          // P0-1: 背壓控制 - 已在上方 dataChunk 處理時暫停，此處僅記錄狀態
          // 移除重複的 pause 邏輯，避免競態條件

          if (!processing) {
            setImmediate(processQueue);
          }
        });

        upstreamResponse.on("end", () => {
          logger.debug(`上游 stream 結束，佇列剩餘: ${queue.length}`, "CHAT");
          // P23: 強制刷新殘留佇列，避免最後幾個 chunk 遺失導致客戶端卡住
          const flushRemaining = async () => {
            while (queue.length > 0) {
              const item = queue.shift();
              try {
                await processSSEPayload(item);
              } catch (error) {
                logger.error("流式資料處理錯誤 (flush)", "CHAT", "", error);
              }
            }
            logger.debug("佇列已清空，resolve pipeUpstream", "CHAT");
            resolve();
          };
          flushRemaining();
        });

        upstreamResponse.on("error", (err) => {
          logger.error(`流式響應讀取錯誤: ${err.message}`, "CHAT", "", err);
          // 僅在回應尚未結束時嘗試發送錯誤訊息
          if (!res.writableEnded) {
            try {
              res.write(
                `data: ${JSON.stringify({
                  id: `chatcmpl-${message_id}`,
                  object: "chat.completion.chunk",
                  created: Math.round(new Date().getTime() / 1000),
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "error",
                    },
                  ],
                })}\n\n`,
              );
              res.end();
            } catch (_) {
              /* response may already be closed */
            }
          }
          reject(err); // 改為 reject，讓呼叫者感知錯誤
        });
      });

    // P0-2: 傳遞 abortController 給 pipeUpstream
    await pipeUpstream(response, options.abortController || null);

    // 🐛 FIX: 串流結束後檢查上游健康狀態，若擁塞則記錄警告
    try {
      if (typeof getUpstreamHealth === "function") {
        const health = getUpstreamHealth();
        if (health?.congested) {
          logger.warn(
            `⚠️ 串流結束時上游仍標記為擁塞 (lastCheck: ${new Date(health.lastCheck).toISOString()})`,
            "CHAT",
          );
        }
      }
    } catch (e) {
      logger.debug(`getUpstreamHealth check failed: ${e.message}`, "CHAT");
    }

    // tool_choice="required" 強校驗：未觸發任何工具呼叫則追加更強提示重試一次
    if (
      hasTools &&
      toolParser &&
      !toolParser.hasEmittedAnyCall() &&
      requiresToolCall(toolChoice)
    ) {
      const retryHint = buildRequiredRetryHint(toolChoice);
      // P2-1: 重試時保留 requestId 以維持冪等性
      const retryBody = {
        ...requestBody,
        requestId: requestBody.requestId,
        messages: [
          ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
          { role: "system", content: retryHint },
        ],
      };
      logger.warning?.(
        "tool_choice=required 首次未觸發工具呼叫，等待 2s 後重試",
        "CHAT",
      );
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const retryResp = await sendChatRequest(retryBody);
        if (retryResp.status && retryResp.response) {
          await pipeUpstream(
            retryResp.response,
            options.abortController || null,
          );
        }
      } catch (e) {
        logger.error("required 模式重試失敗", "CHAT", "", e);
      }
    }

    // flush 工具呼叫解析器中的殘留內容
    if (toolParser) {
      const tail = toolParser.flush();
      if (tail.textDelta) writeContentDelta(tail.textDelta);
      if (tail.completedCalls.length > 0)
        writeToolCallsDelta(tail.completedCalls);
    }

    // 處理最終的搜尋資訊（僅在 thinking 未發生時才補在結尾）
    if (
      !thinking_start &&
      web_search_info &&
      config.searchInfoMode === "text"
    ) {
      const webSearchTable = await accountManager.generateMarkdownTable(
        web_search_info,
        "text",
      );
      writeContentDelta(`\n\n---\n${webSearchTable}`);
    }

    // P0: 使用增量 token 計數器計算最終使用量，避免傳遞大字串
    if (
      totalTokens.prompt_tokens === 0 &&
      totalTokens.completion_tokens === 0
    ) {
      const promptTokens = countTokens(
        requestBody?.messages
          ? JSON.stringify(requestBody.messages)
          : promptText,
      );
      totalTokens = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokenCount,
        total_tokens: promptTokens + completionTokenCount,
      };
      logger.debug(
        `流式使用tiktoken增量計算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    } else {
      logger.debug(
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

    const finishReason =
      toolParser && toolParser.hasEmittedAnyCall() ? "tool_calls" : "stop";
    res.write(
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

    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${message_id}`,
        object: "chat.completion.chunk",
        created: Math.round(new Date().getTime() / 1000),
        choices: [],
        usage: totalTokens,
      })}\n\n`,
    );

    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (error) {
    logger.error("聊天處理錯誤", "CHAT", "", error);
    try {
      res.status(500).json({ error: "服務錯誤!!!" });
    } catch (_) {
      /* response already started */
    }
  }
};

/**
 * 處理非流式響應（從流式資料累積完整響應）
 * @param {object} res - Express 響應物件
 * @param {object} response - 上游響應流
 * @param {boolean} enable_thinking - 是否啟用思考模式
 * @param {boolean} enable_web_search - 是否啟用網路搜尋
 * @param {string} model - 模型名稱
 * @param {object} requestBody - 原始請求體，用於提取prompt資訊
 * @param {object} [options] - 擴充套件選項
 * @param {boolean} [options.has_tools] - 是否啟用工具呼叫解析
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
    let answerContent = "";
    let thinkingContent = "";
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
     * 把一個上游響應流讀完並累積到 fullContent
     * @param {object} upstreamResponse - axios stream 響應
     * @returns {Promise<void>} 流處理完成的 Promise
     */
    const accumulateUpstream = (upstreamResponse) =>
      new Promise((resolve, reject) => {
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        upstreamResponse.on("data", (chunk) => {
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
                  answerContent += `${newImageMarkdownList.join("\n\n")}\n\n`;
                  newImageMarkdownList.forEach((it) =>
                    appendedImageMarkdownSet.add(it),
                  );
                }
              }

              if (
                !delta ||
                !delta.content ||
                (delta.phase !== "think" && delta.phase !== "answer")
              ) {
                continue;
              }

              let content = delta.content;

              if (delta.phase === "think") {
                thinking_start = true;
                thinkingContent += content;
                continue; // thinking 不進 answerContent
              }

              // delta.phase === "answer"
              if (!thinking_end && thinking_start) {
                thinking_end = true;
                // flush pending images on transition
                if (pendingImageMarkdownList.length > 0) {
                  answerContent += `${pendingImageMarkdownList.join("\n\n")}\n\n`;
                  pendingImageMarkdownList.forEach((it) =>
                    appendedImageMarkdownSet.add(it),
                  );
                  pendingImageMarkdownList = [];
                }
              }

              answerContent += content;
            } catch (error) {
              logger.error("非流式資料處理錯誤", "CHAT", "", error);
            }
          }
        });

        upstreamResponse.on("end", () => resolve());
        upstreamResponse.on("error", (err) => {
          logger.error(
            "非流式響應讀取錯誤，以已累積資料繼續處理",
            "CHAT",
            "",
            err,
          );
          logger.error(`錯誤詳情: ${err.message}\n堆疊: ${err.stack}`, "CHAT");
          resolve();
        });
      });

    await accumulateUpstream(response);

    // 工具呼叫解析：從 answerContent 抽取 <tool_call> 塊
    let assistantContent = answerContent;
    let toolCalls = [];
    if (hasTools) {
      const parsed = parseToolCallsFromText(answerContent);
      assistantContent = parsed.cleanedText;
      toolCalls = parsed.toolCalls;
    }

    // tool_choice="required" 強校驗：未觸發則重試一次
    if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)) {
      const retryHint = buildRequiredRetryHint(toolChoice);
      // P2-1: 重試時保留 requestId 以維持冪等性
      const retryBody = {
        ...requestBody,
        requestId: requestBody.requestId,
        messages: [
          ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
          { role: "system", content: retryHint },
        ],
      };
      logger.warning?.(
        "tool_choice=required 首次未觸發工具呼叫，等待 2s 後重試",
        "CHAT",
      );
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const retryResp = await sendChatRequest(retryBody);
        if (retryResp.status && retryResp.response) {
          const before = answerContent;
          await accumulateUpstream(retryResp.response);
          const retriedText = answerContent.slice(before.length);
          const parsedRetry = parseToolCallsFromText(retriedText);
          if (parsedRetry.toolCalls.length > 0) {
            toolCalls = parsedRetry.toolCalls;
            assistantContent =
              parseToolCallsFromText(answerContent).cleanedText;
          }
        }
      } catch (e) {
        logger.error("required 模式重試失敗", "CHAT", "", e);
      }
    }

    // 處理最終的搜尋資訊（僅在 thinking 未發生時才補在結尾）
    if (
      !thinking_start &&
      web_search_info &&
      config.searchInfoMode === "text"
    ) {
      const webSearchTable = await accountManager.generateMarkdownTable(
        web_search_info,
        "text",
      );
      assistantContent += `\n\n---\n${webSearchTable}`;
    }

    // 合併 thinking + answer 用於 token 估算
    const fullContent = thinkingContent
      ? `${thinkingContent}\n\n${assistantContent}`
      : assistantContent;

    // 計算最終的token使用量
    if (
      totalTokens.prompt_tokens === 0 &&
      totalTokens.completion_tokens === 0
    ) {
      totalTokens = createUsageObject(
        requestBody?.messages || promptText,
        fullContent,
        null,
      );
      logger.debug(
        `非流式使用tiktoken計算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`,
        "CHAT",
      );
    } else {
      logger.debug(
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

    const assistantMessage = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (thinkingContent) {
      assistantMessage.reasoning_content = thinkingContent;
    }
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
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
    logger.error("非流式聊天處理錯誤", "CHAT", "", error);
    res.status(500).json({
      error: "服務錯誤!!!",
    });
  }
};

/**
 * 主要的聊天完成處理函式
 * @param {object} req - Express 請求物件
 * @param {object} res - Express 響應物件
 */
const handleChatCompletion = async (req, res) => {
  const { stream, model } = req.body;

  const enable_thinking = req.enable_thinking;
  const enable_web_search = req.enable_web_search;

  // P0: 等待併發許可 — 保護 waf-proxy 不被淹沒
  await acquireOutgoing();
  try {
    const response_data = await sendChatRequest(req.body);

    if (!response_data.status || !response_data.response) {
      const errDetail = response_data.error || "未知錯誤";
      const userMsg = response_data.userMessage;
      res.status(503).json({
        error: userMsg || `請求傳送失敗: ${errDetail}`,
        detail: errDetail,
        hint:
          errDetail === "no_token"
            ? "Token 已過期，系統正在背景自動更新（auto-get-token.js）。請稍後再試，或手動執行: cd qwen2api && bun auto-get-token.js"
            : undefined,
      });
      return;
    }

    if (stream) {
      setResponseHeaders(res, true);
      // P0-2: 傳遞 abortController 以支援客戶端斷線中止
      const abortController = new AbortController();
      req.on("close", () => {
        if (!res.writableEnded) {
          abortController.abort();
          logger.info("客戶端請求中斷，中止上游", "CHAT");
        }
      });
      await handleStreamResponse(
        res,
        response_data.response,
        enable_thinking,
        enable_web_search,
        req.body,
        {
          has_tools: req.has_tools,
          tool_choice: req.tool_choice,
          abortController,
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
        { has_tools: req.has_tools, tool_choice: req.tool_choice },
      );
    }
  } catch (error) {
    logger.error("聊天處理錯誤", "CHAT", "", error);
    const isAuth =
      error.message?.includes("401") ||
      error.message?.includes("403") ||
      error.message?.includes("token");
    res.status(500).json({
      error: isAuth
        ? "token無效,請求傳送失敗"
        : `請求傳送失敗: ${error.message || "未知錯誤"}`,
    });
  } finally {
    releaseOutgoing(); // P0: 釋放併發許可
  }
};

module.exports = {
  handleChatCompletion,
  handleStreamResponse,
  handleNonStreamResponse,
  setResponseHeaders,
};
