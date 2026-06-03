const axios = require("axios");
const accountManager = require("../utils/account.js");
const { getSsxmodItna, getSsxmodItna2 } = require("../utils/ssxmod-manager");
const {
  getProxyAgent,
  getChatBaseUrl,
  applyProxyToAxiosConfig,
} = require("../utils/proxy-helper");

// ─── 模型快取 ───
let cachedModels = null;
let fetchPromise = null;
let lastFetchTime = 0;
const CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || "300000"); // 5min

// ─── 不健康模型追蹤（回傳 Model not found 的模型會自動被排除） ───
const unhealthyModels = new Set();
const UNHEALTHY_RESET_MS = parseInt(
  process.env.UNHEALTHY_RESET_MS || "1800000",
); // 30min 後重置

/**
 * 標記模型為不健康（上游回傳 Model not found 時呼叫此函式）
 * @param {string} modelId - 上游實際模型 ID
 */
const markModelUnhealthy = (modelId) => {
  if (!modelId) return;
  unhealthyModels.add(modelId);
  console.log(
    `[models] Marked unhealthy: ${modelId} (${unhealthyModels.size} total)`,
  );
  // 30 分鐘後自動清除，避免上游修復後永遠被排除
  setTimeout(() => {
    unhealthyModels.delete(modelId);
    console.log(`[models] Unhealthy model auto-cleared: ${modelId}`);
  }, UNHEALTHY_RESET_MS);
};

/**
 * 檢查模型是否被標記為不健康
 */
const isModelUnhealthy = (modelId) => {
  return unhealthyModels.has(modelId);
};

/**
 * 取得所有被標記為不健康的模型清單
 */
const getUnhealthyModels = () => {
  return Array.from(unhealthyModels);
};

const getLatestModels = async (force = false) => {
  const now = Date.now();

  // 快取有效且未過期
  if (cachedModels && !force && now - lastFetchTime < CACHE_TTL) {
    // 過濾掉不健康模型後回傳
    return cachedModels.filter((m) => !unhealthyModels.has(m?.id));
  }

  // 若正在取得中，回傳當前的 Promise
  if (fetchPromise) {
    const models = await fetchPromise;
    return models.filter((m) => !unhealthyModels.has(m?.id));
  }

  const chatBaseUrl = getChatBaseUrl();
  const account = await accountManager.getAccount();
  const proxyAgent = getProxyAgent(account);

  const requestConfig = {
    headers: {
      Authorization: `Bearer ${account ? account.token : ""}`,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...(getSsxmodItna() && {
        Cookie: `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
      }),
    },
  };

  if (proxyAgent) {
    requestConfig.httpsAgent = proxyAgent;
    requestConfig.proxy = false;
  }

  fetchPromise = axios
    .get(`${chatBaseUrl}/api/models`, requestConfig)
    .then((response) => {
      cachedModels = response.data.data;
      lastFetchTime = Date.now();
      fetchPromise = null;
      console.log(
        `[models] Cache refreshed: ${cachedModels?.length || 0} models`,
      );
      return cachedModels.filter((m) => !unhealthyModels.has(m?.id));
    })
    .catch((error) => {
      // 啟動初期上游尚未就緒是預期行為（白名單降級已處理），不用紅色錯誤
      if (cachedModels) {
        console.warn("[models] Failed to refresh, using stale cache");
      } else {
        console.warn("[models] Wait for upstream (fallback active)");
      }
      fetchPromise = null;
      // 如果快取過期但仍有舊資料，回傳舊資料（降級）
      if (cachedModels) {
        console.warn("[models] Using stale cache as fallback");
        return cachedModels.filter((m) => !unhealthyModels.has(m?.id));
      }
      return [];
    });

  return fetchPromise;
};

/**
 * 強制重新整理模型快取
 */
const refreshModels = async () => {
  return getLatestModels(true);
};

/**
 * 根據聊天型別獲取預設模型
 * @param {string} chatType - 聊天型別
 * @returns {Promise<string|null>} 預設模型 ID
 */
const getDefaultModelByChatType = async (chatType) => {
  const models = await getLatestModels();
  const matchedModel = models.find((model) =>
    model?.info?.meta?.chat_type?.includes(chatType),
  );
  return matchedModel?.id || null;
};

module.exports = {
  getLatestModels,
  getDefaultModelByChatType,
  refreshModels,
  markModelUnhealthy,
  isModelUnhealthy,
  getUnhealthyModels,
};
