/**
 * auth/oauth.js — OAuth2 認證
 *
 * 支援 client_credentials + refresh token 雙流程。
 * 到期前自動刷新（expiry buffer = 60s）。
 * 適用於：ChatGPT API（OAuth2）、GitHub API、Google API 等。
 */

import { makeLogger } from "../../color.js";
const log = makeLogger("auth:oauth", "success");

export function createOAuthAuth(cfg) {
  const clientId = cfg.clientId || "";
  const clientSecret = cfg.clientSecret || "";
  const tokenUrl = cfg.tokenUrl || "";
  const scopes = cfg.scopes || "";
  const refreshToken = cfg.refreshToken || "";
  const expiryBuffer = cfg.expiryBuffer ?? 60000; // 到期前 60s 預先刷新

  let accessToken = cfg.accessToken || "";
  let expiresAt = cfg.expiresAt || 0; // epoch ms
  let refreshTok = refreshToken;
  let _refreshing = false;

  return {
    type: "oauth",

    init() {
      if (!clientId || !clientSecret) {
        // 如果已有 accessToken（從配置直接給），可跳過完整初始化
        if (accessToken) {
          log.info(`${cfg.name || "?"} 使用預先提供 token`);
          return;
        }
        throw new Error(
          `[auth:oauth] ${cfg.name || "?"} 缺少 clientId/clientSecret`,
        );
      }
      if (!tokenUrl) {
        throw new Error(`[auth:oauth] ${cfg.name || "?"} 缺少 tokenUrl`);
      }
    },

    getHeaders() {
      return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    },

    async refresh() {
      // 防止併發刷新（多個請求同時觸發刷新）
      if (_refreshing) {
        // 等待正在進行的刷新完成
        while (_refreshing) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return true;
      }

      // 檢查是否真的需要刷新
      if (accessToken && Date.now() < expiresAt - expiryBuffer) {
        return true; // 尚未到期
      }

      _refreshing = true;
      try {
        // 優先使用 refresh_token
        const grantType = refreshTok ? "refresh_token" : "client_credentials";
        const params = new URLSearchParams({
          grant_type: grantType,
          client_id: clientId,
          client_secret: clientSecret,
        });
        if (grantType === "refresh_token") {
          params.set("refresh_token", refreshTok);
        }
        if (scopes) {
          params.set("scope", scopes);
        }

        log.info(`${cfg.name || "?"} 刷新 token (grant_type=${grantType})`);

        const res = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(
            `OAuth token 刷新失敗 (HTTP ${res.status}): ${txt.slice(0, 200)}`,
          );
        }

        const data = await res.json();
        accessToken = data.access_token || "";
        const expIn = data.expires_in || 3600;
        expiresAt = Date.now() + expIn * 1000;
        if (data.refresh_token) refreshTok = data.refresh_token;

        log.info(
          `${cfg.name || "?"} token 刷新成功，到期 ${new Date(expiresAt).toISOString()}`,
        );
        return true;
      } catch (e) {
        log.error(`${cfg.name || "?"} OAuth token 刷新失敗: ${e.message}`);
        return false;
      } finally {
        _refreshing = false;
      }
    },

    isHealthy() {
      if (!accessToken) return false;
      // Token 到期則視為不健康
      if (expiresAt > 0 && Date.now() >= expiresAt) return false;
      return true;
    },

    toJSON() {
      return {
        type: "oauth",
        ready: !!accessToken,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        hasRefreshToken: !!refreshTok,
      };
    },
  };
}
