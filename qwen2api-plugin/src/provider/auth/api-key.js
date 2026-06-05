/**
 * auth/api-key.js — API Key 認證
 *
 * 最簡 Bearer token 認證，相容既有 apiKey 欄位。
 * 適用於：OpenAI、Anthropic、DeepSeek 等標準 API Key 端點。
 */

export function createApiKeyAuth(cfg) {
  const key = cfg.apiKey || cfg.key || "";
  const headerKey = cfg.headerKey || "Authorization";
  const headerVal = cfg.headerValue || `Bearer ${key}`;

  return {
    type: "api-key",

    init() {
      if (!key) {
        throw new Error(`[auth:api-key] ${cfg.name || "?"} 缺少 apiKey`);
      }
    },

    getHeaders() {
      return { [headerKey]: headerVal };
    },

    async refresh() {
      // API Key 無需刷新
      return true;
    },

    isHealthy() {
      return key.length > 0;
    },

    toJSON() {
      return {
        type: "api-key",
        ready: key.length > 0,
        headerKey,
      };
    },
  };
}
