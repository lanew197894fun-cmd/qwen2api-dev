const axios = require("axios");
const crypto = require("crypto");
const accountManager = require("./account.js");
const { logger } = require("./logger");
const { getSsxmodItna, getSsxmodItna2 } = require("./ssxmod-manager");
const {
  getProxyAgent,
  getChatBaseUrl,
  applyProxyToAxiosConfig,
} = require("./proxy-helper");
const {
  markModelUnhealthy,
  refreshModels,
} = require("../models/models-map.js");

// ─── 延遲監控與健康廣播 (輕量級) ───
// 用於追蹤上游 API 的響應延遲，當延遲超過閾值時標記為「擁塞」
// chat-proxy 可讀取此狀態以觸發模型降級
// ─── 延遲監控與健康廣播 (輕量級) ───
// 用於追蹤上游 API 的響應延遲，當延遲超過閾值時標記為「擁塞」
// chat-proxy 可讀取此狀態以觸發模型降級
// 筆電開發測試優化：降低閾值至 3s，更快偵測卡死
const LATENCY_THRESHOLD_MS = parseInt(
  process.env.QWEN_LATENCY_THRESHOLD || "3000",
  10,
);
let upstreamCongested = false;
let lastLatencyCheck = 0;

function checkUpstreamHealth() {
  return !upstreamCongested;
}

function recordLatency(ms) {
  lastLatencyCheck = Date.now();
  if (ms > LATENCY_THRESHOLD_MS) {
    if (!upstreamCongested) {
      logger.warn(
        `⚠️ 上游延遲臨界: ${ms}ms > ${LATENCY_THRESHOLD_MS}ms，標記為擁塞`,
        "HEALTH",
      );
      upstreamCongested = true;
    }
  } else {
    // 恢復健康需連續幾次正常或經過一段時間，這裡簡化為立即恢復但設冷卻
    if (upstreamCongested && Date.now() - lastLatencyCheck > 10000) {
      // 簡單冷卻邏輯，實際可更複雜
    }
    if (upstreamCongested && ms < LATENCY_THRESHOLD_MS / 2) {
      logger.info(`✅ 上游延遲恢復: ${ms}ms，解除擁塞標記`, "HEALTH");
      upstreamCongested = false;
    }
  }
}

module.exports.getUpstreamHealth = () => ({
  congested: upstreamCongested,
  lastCheck: lastLatencyCheck,
});

// ─── 冪等性保護：快取已處理的 Request ID（限制容量防止記憶體洩漏） ───
const processedRequests = new Map();
const REQUEST_CACHE_TTL = 60000; // 60秒過期
const MAX_REQUEST_CACHE_SIZE = 10000; // 最大快取容量

// 定期清理過期的 Request ID
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedRequests.entries()) {
    if (now - timestamp > REQUEST_CACHE_TTL) {
      processedRequests.delete(id);
    }
  }
}, 30000);

/**
 * 生成唯一 Request ID
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * 檢查請求是否已處理（冪等性保護）
 */
function isRequestProcessed(requestId) {
  return processedRequests.has(requestId);
}

/**
 * 標記請求為已處理
 */
function markRequestProcessed(requestId) {
  // 防止記憶體洩漏：若超過最大容量，刪除最舊的 10%
  if (processedRequests.size >= MAX_REQUEST_CACHE_SIZE) {
    const keysToDelete = Array.from(processedRequests.keys()).slice(
      0,
      Math.floor(MAX_REQUEST_CACHE_SIZE * 0.1),
    );
    keysToDelete.forEach((k) => processedRequests.delete(k));
  }
  processedRequests.set(requestId, Date.now());
}

// ─── 重試輔助：指數退避，最多 retries 次 ───
async function withRetry(
  fn,
  retries = 0,
  baseDelay = 1000,
  shouldRetry = () => true,
) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries && shouldRetry(err)) {
        const delay = Math.min(baseDelay * Math.pow(2, i), 5000);
        logger.warn(
          `請求重試 ${i + 1}/${retries}: ${err.message}，等待 ${delay}ms`,
          "RETRY",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * 傳送聊天請求
 * @param {Object} body - 請求體
 * @param {number} retryCount - 當前重試次數
 * @param {string} lastUsedEmail - 上次使用的郵箱（用於錯誤記錄）
 * @returns {Promise<Object>} 響應結果
 */
const sendChatRequest = async (
  body,
  retryOnAuth = true,
  authRetryCount = 0,
  signal = null, // P16: 支援 AbortSignal 以實現上游請求中止
) => {
  // 防止無限迴圈：最大認證重試次數
  const MAX_AUTH_RETRIES = 1;
  if (authRetryCount > MAX_AUTH_RETRIES) {
    logger.error("認證重試次數超限，放棄請求", "REQUEST");
    return { status: false, response: null, error: "auth_retry_exhausted" };
  }

  // 冪等性保護：檢查是否為重複請求
  const requestId = body.requestId || generateRequestId();
  if (isRequestProcessed(requestId)) {
    logger.warn(`檢測到重複請求 ID: ${requestId}，跳過處理`, "REQUEST");
    return { status: false, response: null, error: "duplicate_request" };
  }
  markRequestProcessed(requestId);

  const currentAccount = await accountManager.getAccount();
  const currentToken = currentAccount ? currentAccount.token : null;

  if (!currentToken) {
    const isBrowser = currentAccount?.refresh_method === "browser";
    const email = currentAccount?.email || "";
    if (isBrowser) {
      const hint = `帳戶 ${email} token 已過期，auto-get-token.js 背景更新中，請稍後再試。若持續失敗請手動執行: cd qwen2api && bun auto-get-token.js`;
      logger.warn(hint, "TOKEN");
      return {
        status: false,
        response: null,
        error: "no_token",
        userMessage: hint,
      };
    }
    logger.error("無法獲取有效的訪問令牌", "TOKEN");
    return { status: false, response: null, error: "no_token" };
  }

  const chatBaseUrl = getChatBaseUrl();
  const proxyAgent = getProxyAgent(currentAccount);

  const requestConfig = {
    headers: {
      Authorization: `Bearer ${currentToken}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      Connection: "keep-alive",
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/json",
      Timezone: "Mon Dec 08 2025 17:28:55 GMT+0800",
      "sec-ch-ua":
        '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      source: "web",
      Version: "0.1.13",
      "bx-v": "2.5.31",
      Origin: chatBaseUrl,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Referer: `${chatBaseUrl}/c/guest`,
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      Cookie: `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
      "X-Request-ID": requestId, // 新增 Request ID 標頭
    },
    responseType: "stream",
    timeout: parseInt(process.env.QWEN_CHAT_TIMEOUT || "600000", 10), // P24: 降低至 10 分鐘，避免無限等待
    signal: signal, // P16: 綁定 AbortSignal 以支援客戶端斷線時中止上游請求
  };

  if (proxyAgent) {
    requestConfig.httpsAgent = proxyAgent;
    requestConfig.proxy = false;
  }

  const chat_id = await generateChatID(
    currentToken,
    body.model,
    currentAccount,
  );

  // 修復 1: 驗證 chat_id 不為 null 才發送請求
  if (!chat_id) {
    logger.error("生成chat_id失敗，無法發送請求", "REQUEST");
    return { status: false, response: null, error: "chat_id_failed" };
  }

  // 定義可重試的錯誤類型
  const RETRYABLE_ERRORS = [
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EPIPE",
    "ERR_SOCKET_CLOSED",
    "502",
    "503",
    "504",
  ];
  const shouldRetry = (err) => {
    const statusCode = err.response?.status;
    const errorCode = err.code;
    const msg = err.message || "";
    // 偵測 socket 意外關閉（DashScope 常見問題）
    const isSocketError =
      msg.includes("socket connection was closed") ||
      msg.includes("unexpectedly") ||
      errorCode === "ECONNRESET" ||
      errorCode === "EPIPE";
    return (
      RETRYABLE_ERRORS.includes(errorCode) ||
      (statusCode >= 500 && statusCode < 600) ||
      isSocketError
    );
  };

  try {
    logger.network(`傳送聊天請求`, "REQUEST");
    // 🐛 FIX: 記錄請求開始時間用於計算 TTFB
    body._requestStartTime = Date.now();
    const response = await withRetry(
      () =>
        axios.post(
          `${chatBaseUrl}/api/v2/chat/completions?chat_id=${chat_id}`,
          {
            ...body,
            stream: true,
            chat_id: chat_id,
          },
          {
            ...requestConfig,
            // P4: 強制禁用 axios 內部緩衝，確保 SSE chunk 即時傳遞
            maxRedirects: 0,
            decompress: true,
            // P19: 增加 keepAlive 與 socket 超時設定，防止上游意外斷線
            agent: proxyAgent || undefined,
            timeout: parseInt(process.env.QWEN_CHAT_TIMEOUT || "900000", 10),
          },
        ),
      2, // FIX: transient 503/504 時重試 2 次（原 0），避免短暫波動直接中斷
      1500, // 增加基礎延遲至 1.5s（原 1s）
      shouldRetry, // 使用條件重試
    );

    if (response.status === 200) {
      // P4: 驗證 response.data 是否為有效的 stream 物件
      if (!response.data || typeof response.data.on !== "function") {
        logger.error("上游返回非 stream 資料，可能 API 格式變更", "REQUEST");
        return {
          status: false,
          response: null,
          error: "invalid_stream_response",
        };
      }
      // 🐛 FIX: 記錄首包延遲 (TTFB) 用於健康監控
      const ttfb = Date.now() - (body._requestStartTime || Date.now());
      recordLatency(ttfb);
      return {
        currentToken: currentToken,
        status: true,
        response: response.data,
      };
    }

    return { status: false, response: null, error: "http_" + response.status };
  } catch (error) {
    const statusCode = error.response?.status;
    const isAuthError = statusCode === 401 || statusCode === 403;

    // 偵測 Model not found → 自動標記該模型為不健康並刷新快取
    const respData = error.response?.data;
    let respBody = "";
    if (respData) {
      try {
        respBody =
          typeof respData === "string" ? respData : JSON.stringify(respData);
      } catch {
        respBody = String(respData);
      }
    }
    const isModelNotFound =
      respBody.includes("Model not found") || respBody.includes("Not_Found");

    if (isModelNotFound && body?.model) {
      logger.warn(
        `[models] Model not found: ${body.model} — marking unhealthy`,
        "REQUEST",
      );
      markModelUnhealthy(body.model);
      // 異步刷新模型快取，不等完成
      refreshModels().catch(() => {});
    }

    // 修復 2: 遇認證錯誤時重新整理 token 後重試一次（帶計數器防止無限迴圈）
    if (
      isAuthError &&
      retryOnAuth &&
      currentAccount?.email &&
      authRetryCount < MAX_AUTH_RETRIES
    ) {
      logger.warn(
        `令牌可能已過期，嘗試重新整理後重試 (${authRetryCount + 1}/${MAX_AUTH_RETRIES}): ${currentAccount.email}`,
        "REQUEST",
      );
      accountManager.recordAccountFailure(currentAccount.email);
      const refreshed = await accountManager.refreshAccountToken(
        currentAccount.email,
      );
      if (refreshed) {
        logger.info(
          `令牌重新整理成功，重發請求: ${currentAccount.email}`,
          "REQUEST",
        );
        // 重試時使用相同的 requestId 以保持冪等性，並遞增計數器
        return sendChatRequest(
          { ...body, requestId },
          false,
          authRetryCount + 1,
        );
      }
    }

    const errMsg =
      error.response?.data?.error?.message || error.message || "未知錯誤";
    logger.error("傳送聊天請求失敗", "REQUEST", "", errMsg);
    return { status: false, response: null, error: errMsg };
  }
};

/**
 * 生成chat_id
 * @param {string} currentToken
 * @param {string} model
 * @param {Object} [account] - 當前帳戶物件（用於解析帳號級代理）
 * @returns {Promise<string|null>} 返回生成的chat_id，如果失敗則返回null
 */
const generateChatID = async (currentToken, model, account) => {
  try {
    const chatBaseUrl = getChatBaseUrl();
    const proxyAgent = getProxyAgent(account);

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        Connection: "keep-alive",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Content-Type": "application/json",
        Timezone: "Mon Dec 08 2025 17:28:55 GMT+0800",
        "sec-ch-ua":
          '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        source: "web",
        Version: "0.1.13",
        "bx-v": "2.5.31",
        Origin: chatBaseUrl,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        Referer: `${chatBaseUrl}/c/guest`,
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        Cookie: `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
      },
    };

    // 新增代理配置
    if (proxyAgent) {
      requestConfig.httpsAgent = proxyAgent;
      requestConfig.proxy = false;
    }

    const response_data = await withRetry(
      () =>
        axios.post(
          `${chatBaseUrl}/api/v2/chats/new`,
          {
            title: "New Chat",
            models: [model],
            chat_mode: "local",
            chat_type: "t2i",
            timestamp: new Date().getTime(),
          },
          requestConfig,
        ),
      3, // FIX: upstream 503 短暫波動時重試 3 次（原 0），指數退避 500ms→1s→2s
      500,
    );

    return response_data.data?.data?.id || null;
  } catch (error) {
    logger.error("生成chat_id失敗", "CHAT", "", error.message);
    // 偵測 Model not found — 上游不認識這個模型 ID
    const respBody = error.response?.data
      ? typeof error.response.data === "string"
        ? error.response.data
        : JSON.stringify(error.response.data)
      : "";
    if (
      respBody.includes("Model not found") ||
      respBody.includes("Not_Found")
    ) {
      logger.warn(
        `[models] Chat creation failed — model not found: ${model}`,
        "CHAT",
      );
      markModelUnhealthy(model);
      refreshModels().catch(() => {});
    }
    return null;
  }
};

module.exports = {
  sendChatRequest,
  generateChatID,
  getUpstreamHealth: () => ({
    congested: upstreamCongested,
    lastCheck: lastLatencyCheck,
  }),
};
