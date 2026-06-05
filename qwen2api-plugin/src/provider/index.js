/**
 * provider/index.js — Provider 模組匯出
 *
 * 使用方式：
 *   import { createRouter } from "./provider/index.js"
 *   const router = createRouter(CFG)
 *   const { data } = await router.exec("POST", "/v1/chat/completions", body, { trace: "abc1" })
 */

import { Provider } from "./provider.js";
import { Router } from "./router.js";
import { createAuth } from "./auth/index.js";

export { Provider };
export { Router };
export { createAuth };

const log = {
  info: (...a) => console.log("[provider]", ...a),
  warn: (...a) => console.warn("[provider]", ...a),
};

/**
 * 從 CFG 配置建立 Router 實例
 * @param {object} cfg  CFG 設定物件（來自 config/index.js）
 * @returns {Router}
 */
export function createRouter(cfg) {
  const providers = [];
  const names = cfg.PROVIDER_NAMES || ["qwen2api"];

  for (const name of names) {
    const key = name.toUpperCase();
    const prefix = `PROVIDER_${key}`;

    // 從 cfg（環境變數）讀取
    let baseUrl = cfg[`${prefix}_URL`] || cfg[`${prefix}_BASE_URL`];
    let apiKey = cfg[`${prefix}_KEY`] || cfg[`${prefix}_API_KEY`] || "";

    // 預設 qwen2api 端點
    if (!baseUrl && name === "qwen2api") {
      baseUrl = `http://${cfg.QWEN2API_HOST || "127.0.0.1"}:${cfg.QWEN2API_PORT || 3000}`;
    }

    // 通用 API_KEY 作為 qwen2api provider 的最終 fallback
    if (!apiKey && name === "qwen2api") {
      apiKey = cfg.API_KEY || "";
    }

    if (!baseUrl) {
      log.warn(`Provider "${name}": 無 URL，跳過`);
      continue;
    }

    // 解析 auth 設定
    const authType = cfg[`${prefix}_AUTH_TYPE`] || "";
    let authOpts = null;
    if (authType) {
      authOpts = {
        type: authType,
        apiKey: cfg[`${prefix}_AUTH_KEY`] || "",
        key: cfg[`${prefix}_AUTH_KEY`] || "",
        clientId: cfg[`${prefix}_AUTH_CLIENT_ID`] || "",
        clientSecret: cfg[`${prefix}_AUTH_CLIENT_SECRET`] || "",
        tokenUrl: cfg[`${prefix}_AUTH_TOKEN_URL`] || "",
        scopes: cfg[`${prefix}_AUTH_SCOPES`] || "",
        sessionToken: cfg[`${prefix}_AUTH_SESSION_TOKEN`] || "",
        cookieString: cfg[`${prefix}_AUTH_COOKIE_STRING`] || "",
        loginUrl: cfg[`${prefix}_AUTH_LOGIN_URL`] || "",
        username: cfg[`${prefix}_AUTH_USERNAME`] || "",
        password: cfg[`${prefix}_AUTH_PASSWORD`] || "",
        mode: cfg[`${prefix}_AUTH_MODE`] || "sessionToken",
        cookieDomains: cfg[`${prefix}_AUTH_COOKIE_DOMAINS`]
          ? cfg[`${prefix}_AUTH_COOKIE_DOMAINS`]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        accessToken: cfg[`${prefix}_AUTH_ACCESS_TOKEN`] || "",
        expiresAt: parseInt(cfg[`${prefix}_AUTH_EXPIRES_AT`] || "0", 10),
        refreshToken: cfg[`${prefix}_AUTH_REFRESH_TOKEN`] || "",
      };
    }

    const provider = new Provider(name, {
      baseUrl,
      apiKey,
      auth: authOpts ? createAuth(authOpts, name) : null,
      timeout: parseInt(
        cfg[`${prefix}_TIMEOUT`] || cfg.CHAT_TIMEOUT || "120000",
        10,
      ),
      retries: parseInt(cfg[`${prefix}_RETRIES`] ?? cfg.RETRIES ?? "1", 10),
      priority: parseInt(cfg[`${prefix}_PRIORITY`] || "1", 10),
      weight: parseInt(cfg[`${prefix}_WEIGHT`] || "1", 10),
      cbThreshold: parseInt(
        cfg[`${prefix}_CB_THRESHOLD`] || cfg.CB_THRESHOLD || "3",
        10,
      ),
      cbRecovery: parseInt(
        cfg[`${prefix}_CB_RECOVERY`] || cfg.CB_RECOVERY || "30000",
        10,
      ),
    });

    providers.push(provider);
  }

  const router = new Router(providers, cfg.ROUTER_STRATEGY || "failover");

  // 背景健康檢查
  if (cfg.ROUTER_HEALTH_ENABLED !== false) {
    const interval = parseInt(cfg.ROUTER_HEALTH_INTERVAL || "30000", 10);
    router.startHealthChecks(interval);
  }

  log.info(
    `Router init: ${providers.length} providers, strategy=${router.strategy}`,
  );
  for (const p of providers) {
    log.info(
      `  ${p.name}: ${p.baseUrl} (pri=${p.priority}, timeout=${p.timeout}ms)`,
    );
  }

  return router;
}
