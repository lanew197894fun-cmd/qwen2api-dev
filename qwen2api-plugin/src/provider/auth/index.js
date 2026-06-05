/**
 * auth/index.js — Auth 工廠函數
 *
 * 依 cfg.auth.type 選擇對應實作：
 *   api-key → createApiKeyAuth
 *   oauth   → createOAuthAuth
 *   cookie  → createCookieAuth
 *
 * 每個 Provider 實例可掛載一個 auth 物件，負責：
 *   1. init()          — 認證初始化（登入 / token 載入）
 *   2. getHeaders()    — 回傳需注入請求的 headers
 *   3. refresh()       — 刷新 token / cookie（ refresh token / 重新登入）
 *   4. isHealthy()     — 認證是否仍有效
 *   5. toJSON()        — 狀態快照
 *
 * 使用方式（createRouter 中自動解析）：
 *   // config 範例：
 *   // PROVIDER_OPENAI_AUTH_TYPE=oauth
 *   // PROVIDER_OPENAI_AUTH_CLIENT_ID=xxx
 *   // PROVIDER_OPENAI_AUTH_CLIENT_SECRET=xxx
 *   // PROVIDER_OPENAI_AUTH_TOKEN_URL=https://auth.openai.com/token
 */

import { createApiKeyAuth } from "./api-key.js";
import { createOAuthAuth } from "./oauth.js";
import { createCookieAuth } from "./cookie.js";

const log = {
  info: (...a) => console.log("[auth]", ...a),
  warn: (...a) => console.warn("[auth]", ...a),
  error: (...a) => console.error("[auth]", ...a),
};

const AUTH_TYPES = {
  "api-key": createApiKeyAuth,
  oauth: createOAuthAuth,
  cookie: createCookieAuth,
};

/**
 * 根據 cfg.auth 建立認證實例
 * @param {object} authCfg  認證配置片段，必需含 type 欄位
 * @param {string} providerName  Provider 名稱（用於日誌）
 * @returns {object|null}  auth 實例（含 init/getHeaders/refresh/isHealthy/toJSON）
 */
export function createAuth(authCfg, providerName = "?") {
  if (!authCfg || !authCfg.type) return null;

  const type = authCfg.type.toLowerCase();
  const factory = AUTH_TYPES[type];

  if (!factory) {
    log.warn(
      `[${providerName}] 不支援的 auth type: "${type}"，可用: ${Object.keys(AUTH_TYPES).join(", ")}`,
    );
    return null;
  }

  try {
    const auth = factory({ ...authCfg, name: providerName });
    log.info(`[${providerName}] auth 已建立 (type=${type})`);

    // 自動初始化
    try {
      auth.init();
      log.info(`[${providerName}] auth init 成功 (type=${type})`);
    } catch (initErr) {
      log.warn(
        `[${providerName}] auth init 失敗: ${initErr.message}，嘗試 refresh...`,
      );
      // init 失敗時嘗試 refresh（例如 login 模式的延遲登入）
      auth.refresh().catch((e) => {
        log.error(`[${providerName}] auth refresh 也失敗: ${e.message}`);
      });
    }

    return auth;
  } catch (e) {
    log.error(`[${providerName}] 建立 auth 失敗: ${e.message}`);
    return null;
  }
}
