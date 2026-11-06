/**
 * provider.js — Provider 封裝層
 *
 * 每個 Provider 代表一個上游 API 端點，負責：
 * - 請求發送（post / get / stream）
 * - 健康追蹤（成功率、延遲、熔斷）
 * - 自動重試（依 HTTP 狀態碼區分）
 * - 電路熔斷器（連續失敗自動隔離）
 */

import { makeLogger } from "../color.js";
const log = makeLogger("provider", "primary");

export class Provider {
  constructor(name, opts = {}) {
    this.name = name;
    this.baseUrl = opts.baseUrl || "";
    this.apiKey = opts.apiKey || "";
    this.timeout = opts.timeout || 120000;
    this.maxRetries = opts.retries ?? 1;
    this.priority = opts.priority ?? 1;
    this.weight = opts.weight ?? 1;

    // 健康檢查端點（預設 /models 不需 auth，相容 qwen2api 上游）
    this.healthEndpoint = opts.healthEndpoint || "/models";

    // Auth integration
    this.auth = opts.auth || null;

    // Circuit breaker (Tuned: higher threshold, longer cooldown to avoid oscillation)
    // ═══ Fix 2026-07-08: 3→5 / 5s→30s 避免 WAF 短暫波動導致熔斷器反覆觸發 ═══
    // 原 3 次失敗 + 5s 恢復 → upstream 短暫異常時快速 oscillation（fail→recover→fail）
    // 5 次失敗 + 30s 恢復 → WAF 有足夠冷卻時間，且單次波動不觸發熔斷
    this.cbThreshold = opts.cbThreshold ?? 5;
    this.cbRecovery = opts.cbRecovery ?? 30000; // 30s for upstream WAF cooldown
    this.halfOpenMaxRetries = opts.halfOpenMaxRetries ?? 1;

    // Health state
    this.healthy = true;
    this.consecutiveFails = 0;
    this.circuitUntil = 0;
    this.failCount = 0;
    this.successCount = 0;
    this.avgLatency = 0;
    this.lastLatency = 0;
    this.lastSuccess = Date.now();
    this.lastError = "";

    // ═══ 2026-07-13: 免額耗盡狀態（403 quota）═══
    // 免額到期 → 標記 quotaExhaustedUntil，期間不重試、直接 failover。
    // 預估重置時間：免額通常每日重置，預設 +24h；成功回應即清除（使用後判斷趨向）。
    this.quotaExhaustedUntil = 0;
    this.quotaResetAt = 0;

    // Separate health-check failure counter (does NOT trigger circuit breaker)
    this._healthFails = 0;
    this._maxHealthFails = 2; // mark unhealthy after 2 consecutive bad health checks
  }

  /** 建立請求 headers（合併 base + auth） */
  _buildHeaders(extra = {}) {
    const h = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
    if (this.auth) {
      Object.assign(h, this.auth.getHeaders());
    }
    return h;
  }

  /** 刷新認證（若 auth 支援）*/
  async refreshAuth() {
    if (this.auth && typeof this.auth.refresh === "function") {
      try {
        return await this.auth.refresh();
      } catch (e) {
        log.warn(`${this.name}: auth refresh 失敗 - ${e.message}`);
        return false;
      }
    }
    return true;
  }

  /** 是否可用（支援半開狀態重試） */
  get available() {
    const now = Date.now();
    // ═══ 2026-07-13: 免額耗盡期間不可用（等重置）═══
    if (this.quotaExhaustedUntil > now) {
      return false;
    }
    if (this.circuitUntil > now) {
      // Half-open state: allow limited retries to test recovery
      if (this.consecutiveFails < this.cbThreshold + this.halfOpenMaxRetries) {
        return true;
      }
      return false;
    }
    return true;
  }

  /** 記錄成功 */
  recordSuccess(latency) {
    this.successCount++;
    this.consecutiveFails = 0;
    this.circuitUntil = 0;
    this.healthy = true;
    // ═══ 成功回應清除免額標記：靜默（功能保留）═══
    if (this.quotaExhaustedUntil > 0) {
      this.quotaExhaustedUntil = 0;
      this.quotaResetAt = 0;
    }
    this.lastLatency = latency;
    this.avgLatency = this.avgLatency
      ? this.avgLatency * 0.9 + latency * 0.1
      : latency;
    this.lastSuccess = Date.now();
  }

  /** 記錄失敗 */
  recordFailure(err) {
    this.consecutiveFails++;
    this.failCount++;
    this.lastError = String(err || "").slice(0, 200);

    // Auto-trigger self-learning feedback on critical failures
    if (this.consecutiveFails >= this.cbThreshold) {
      this._triggerSelfLearning(err);
    }

    if (this.consecutiveFails >= this.cbThreshold) {
      this.circuitUntil = Date.now() + this.cbRecovery;
      this.healthy = false;
      log.warn(
        `🔴 ${this.name}: 熔斷器觸發 (${this.consecutiveFails}次連續失敗，冷卻 ${this.cbRecovery / 1000}s)`,
      );
    }
  }

  /** 觸發自我學習系統紀錄錯誤 */
  _triggerSelfLearning(err) {
    import("../self-learning.js")
      .then((mod) => {
        if (mod.recordError) {
          mod.recordError({
            provider: this.name,
            error: String(err).slice(0, 500),
            context: `Circuit breaker triggered after ${this.consecutiveFails} fails`,
          });
        }
      })
      .catch((e) => log.warn("self-learning import fail:", e?.message));
  }

  /**
   * 判斷 HTTP 狀態碼是否可重試
   * 5xx/408/429/502/503/504 → 暫時性錯誤，可重試
   * 4xx（除 408/429） → 客戶端錯誤，不可重試
   */
  _isRetryable(status) {
    if (status >= 500) return true;
    if ([408, 429, 502, 503, 504].includes(status)) return true;
    return false;
  }

  /**
   * 2026-10-21 Fix（主因）：Qwen chat challenge（WAF 風控）偵測
   * 尖峰時段上游回 503「被挤爆啦 / FAIL_SYS_USER_VALIDATE / _____tmd_____」。
   * 這是 IP 級風控（與帳戶/Provider 健康無關），30 秒內重試必敗且加重判定。
   * → 不重試、不計入熔斷，直接拋出 challenge 標記錯誤讓上層快速降級。
   */
  static _CHALLENGE_RE =
    /fail_sys_user_validate|rgv587|被挤爆|captcha|_____tmd_____|punish\?|x5secdata|chat challenge/i;

  _isChallenge(txt) {
    return Provider._CHALLENGE_RE.test(txt || "");
  }

  /** 解析 Retry-After header（秒），無效回傳 0 */
  _retryAfterSec(res) {
    const v = parseInt(res.headers?.get?.("retry-after") || "", 10);
    return Number.isFinite(v) && v > 0 ? Math.min(v, 60) : 0;
  }

  /** 建立 challenge 錯誤（不計熔斷） */
  _challengeErr(status, txt, retryAfter) {
    return Object.assign(
      new Error(`chat_challenge: ${String(txt).slice(0, 120)}`),
      { status, challenge: true, retryAfter: retryAfter || 30, body: String(txt).slice(0, 500) },
    );
  }

  /** 解析免額重置時間（預設下一個 UTC+8 午夜，嘗試從錯誤提示提取） */
  _parseQuotaReset(txt) {
    const now = Date.now();
    const m = (txt || "").match(/(\d{1,2}):(\d{2})/);
    if (m) {
      try {
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const d = new Date();
        d.setHours(h, min, 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
      } catch {}
    }
    // DashScope 免費額度每日 00:00（北京時間 UTC+8）重置 → 預設下一個 UTC+8 午夜
    const _utc8 = new Date(now + 8 * 60 * 60 * 1000);
    _utc8.setUTCHours(16, 0, 0, 0); // UTC 16:00 = 北京 00:00
    if (_utc8.getTime() <= now) _utc8.setUTCDate(_utc8.getUTCDate() + 1);
    return _utc8.getTime();
  }

  /**
   * POST 請求（含重試 + 健康追蹤）
   * @param {string} path  API 路徑（如 /v1/chat/completions）
   * @param {object} body  JSON body
   * @param {object} opts  選項：timeout, retries, headers, trace
   */
  async post(path, body, opts = {}) {
    const timeout = opts.timeout || this.timeout;
    const retries = opts.retries ?? this.maxRetries;
    const trace = opts.trace || "----";
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders(opts.headers || {});

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        const latency = Date.now() - start;
        const txt = await res.text();

        if (res.ok) {
          // 檢查回應內容是否包含每日限額錯誤（HTTP 200 但業務邏輯失敗）
          const dailyLimitPatterns = [
            "每日使用限制",
            "daily limit",
            "rate limit exceeded",
            "quota exceeded",
            "已達到每日",
            "每日額度",
            "daily quota",
            "too many requests",
            "請等待",
            "try again later",
          ];
          const isDailyLimit = dailyLimitPatterns.some((p) =>
            txt.toLowerCase().includes(p.toLowerCase()),
          );
          if (isDailyLimit) {
            log.warn(
              `[${trace}] ${this.name} 偵測到每日限額錯誤，觸發 failover: ${txt.slice(0, 120)}`,
            );
            this.recordFailure("daily_limit");
            const err = new Error(`Daily limit: ${txt.slice(0, 200)}`);
            err.status = 429; // 視為 429 以觸發重試/切換
            throw err;
          }

          this.recordSuccess(latency);
          try {
            return JSON.parse(txt);
          } catch {
            return { content: txt };
          }
        }

        // 401 → 認證失效，嘗試刷新 auth 後重試一次
        if (res.status === 401 && this.auth && attempt < retries) {
          log.info(`[${trace}] ${this.name} HTTP 401，嘗試刷新認證...`);
          const refreshed = await this.refreshAuth();
          if (refreshed) {
            // 更新 headers（新 token）
            Object.assign(headers, this.auth.getHeaders());
            // 立即重試（不計入重試計數，共多一次 auth-refresh 機會）
            continue;
          }
        }

        // ═══ 2026-10-21 Fix（主因）：chat challenge → 不重試、不計熔斷 ═══
        if ((res.status === 503 || res.status === 403) && this._isChallenge(txt)) {
          const ra = this._retryAfterSec(res) || 30;
          log.warn(
            `[${trace}] ${this.name} chat challenge（風控，非 Provider 故障）→ 快速失敗 retryAfter=${ra}s`,
          );
          throw this._challengeErr(res.status, txt, ra);
        }

        // HTTP 錯誤：判斷是否可重試
        if (this._isRetryable(res.status) && attempt < retries) {
          // 2026-10-21: 尊重 Retry-After，避免 2s 直接 hammer 上游加重風控
          const raMs = this._retryAfterSec(res) * 1000;
          const wait = Math.max(Math.min(2000 * 2 ** attempt, 10000), raMs);
          const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
          log.info(
            `[${trace}] ${this.name} HTTP ${res.status}，重試 ${attempt + 1}/${retries} (${jittered}ms)`,
          );
          await new Promise((r) => setTimeout(r, jittered));
          continue;
        }

        // ═══ 403 免額耗盡：功能保留（標記不可用），日誌靜默（不重置，warn 輸出無意義）═══
        if (res.status === 403) {
          const _isQuota = /quota|limit|額度|限額|exceeded|免額|free/i.test(
            txt,
          );
          if (_isQuota) {
            const _reset = this._parseQuotaReset(txt);
            this.quotaExhaustedUntil = _reset;
            this.quotaResetAt = _reset;
            throw Object.assign(
              new Error(`Quota exhausted: ${txt.slice(0, 200)}`),
              { status: 403, quota: true, body: txt.slice(0, 500) },
            );
          }
          // 非 quota 的 403（如 key 無權限）→ 仍計斷路器
          this.recordFailure(`HTTP 403`);
          throw Object.assign(new Error(`HTTP 403: ${txt.slice(0, 200)}`), {
            status: 403,
            body: txt.slice(0, 500),
          });
        }

        this.recordFailure(`HTTP ${res.status}`);
        throw Object.assign(
          new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`),
          {
            status: res.status,
            body: txt.slice(0, 500),
          },
        );
      } catch (e) {
        const latency = Date.now() - start;
        lastErr = e;
        const msg = e.message || "";
        const isTimeout = e.name === "AbortError";
        const isNetwork =
          msg.includes("ECONNRESET") ||
          msg.includes("ECONNREFUSED") ||
          msg.includes("ENOTFOUND") ||
          msg.includes("ETIMEDOUT");
        const canRetry = isTimeout || isNetwork;

        if (canRetry && attempt < retries) {
          const wait = Math.min(2000 * 2 ** attempt, 10000);
          const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
          log.info(
            `[${trace}] ${this.name} ${isTimeout ? "timeout" : msg.slice(0, 60)}，重試 ${attempt + 1}/${retries} (${jittered}ms)`,
          );
          await new Promise((r) => setTimeout(r, jittered));
          continue;
        }

        // 有 HTTP status 的錯誤（已在上層 recordFailure）
        if (e.status) break;

        this.recordFailure(isTimeout ? "timeout" : msg.slice(0, 120));
        throw e;
      }
    }

    if (lastErr) {
      if (!lastErr.status) this.recordFailure(lastErr?.message || "unknown");
      throw lastErr;
    }
    throw new Error("max retries exceeded");
  }

  /**
   * GET 請求（輕量，用於健康檢查等）
   */
  async get(path, opts = {}) {
    const timeout = opts.timeout || Math.min(this.timeout, 15000);
    const retries = opts.retries ?? 1;
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(timeout),
        });
        const latency = Date.now() - start;
        const txt = await res.text();

        if (res.ok) {
          this.recordSuccess(latency);
          try {
            return JSON.parse(txt);
          } catch {
            return null;
          }
        }

        // 401 → 嘗試刷新認證
        if (res.status === 401 && this.auth) {
          await this.refreshAuth();
          Object.assign(headers, this.auth.getHeaders());
          continue;
        }

        if (this._isRetryable(res.status) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        return null;
      } catch {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * 串流請求 — 回傳原始 Response（呼叫端負責 pipe）
   * 不回傳完整 body，適合 SSE 串流場景
   * 🐛 FIX: 加入 transient error（5xx/超時/網路抖動）重試機制
   */
  async stream(path, body, opts = {}) {
    const timeout = opts.timeout || this.timeout;
    const retries = opts.retries ?? 1;
    const trace = opts.trace || "----";
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: opts.signal || AbortSignal.timeout(timeout),
        });

        if (res.ok && res.body) {
          this.recordSuccess(0);
          return res;
        }

        const status = res.status;

        // 401 → 嘗試刷新認證後重試一次
        if (status === 401 && this.auth && attempt === 0) {
          log.info(`[${trace}] ${this.name} stream HTTP 401，嘗試刷新認證...`);
          const refreshed = await this.refreshAuth();
          if (refreshed) {
            Object.assign(headers, this.auth.getHeaders());
            continue;
          }
        }

        // ═══ 2026-10-21 Fix（主因）：stream 503 → 讀 body 偵測 chat challenge ═══
        let _txt503 = "";
        if (status === 503 || status === 403) {
          _txt503 = await res.text().catch(() => "");
          if (this._isChallenge(_txt503)) {
            const ra = this._retryAfterSec(res) || 30;
            log.warn(
              `[${trace}] ${this.name} stream chat challenge（風控）→ 快速失敗 retryAfter=${ra}s`,
            );
            throw this._challengeErr(status, _txt503, ra);
          }
        }

        // 5xx/408/429/502/503/504 → 暫時性錯誤，可重試
        const isRetryable = status >= 500 || [408, 429].includes(status);
        if (isRetryable && attempt < retries) {
          // 2026-10-21: 尊重 Retry-After（qwen2api 503 帶 Retry-After: 30）
          const raMs = this._retryAfterSec(res) * 1000;
          const wait = Math.max(Math.min(2000 * 2 ** attempt, 8000), raMs);
          const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
          log.info(
            `[${trace}] ${this.name} stream HTTP ${status}，重試 ${attempt + 1}/${retries} (${jittered}ms)`,
          );
          await new Promise((r) => setTimeout(r, jittered));
          continue;
        }

        this.recordFailure(`stream:HTTP ${status}`);
        try {
          const txt = _txt503 || (await res.text());
          throw Object.assign(
            new Error(`HTTP ${status}: ${txt.slice(0, 200)}`),
            { status, body: txt.slice(0, 500) },
          );
        } catch (e) {
          if (e.status) throw e;
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        }
      } catch (e) {
        // 2026-10-21: challenge 與 Provider 健康無關 → 不計熔斷、不重試
        if (e.challenge) throw e;
        // 網路錯誤/超時，可重試
        const latency = Date.now() - start;
        const msg = e.message || "";
        const isTimeout = e.name === "AbortError" || msg.includes("timeout");
        const isNetwork =
          msg.includes("ECONNRESET") ||
          msg.includes("ECONNREFUSED") ||
          msg.includes("ENOTFOUND") ||
          msg.includes("ETIMEDOUT");

        if ((isTimeout || isNetwork) && attempt < retries) {
          const wait = Math.min(2000 * 2 ** attempt, 8000);
          const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
          log.info(
            `[${trace}] ${this.name} stream ${isTimeout ? "timeout" : msg.slice(0, 60)}，重試 ${attempt + 1}/${retries} (${jittered}ms)`,
          );
          await new Promise((r) => setTimeout(r, jittered));
          continue;
        }

        this.recordFailure(
          isTimeout ? "stream:timeout" : `stream:${msg.slice(0, 120)}`,
        );
        throw e;
      }
    }
    // Should not reach here (retries exhausted → last throw propagates)
  }

  /** 健康檢查 — 獨立計數器（不影響 API 熔斷器） */
  async checkHealth() {
    // 先檢查 auth 健康狀態
    if (this.auth && !this.auth.isHealthy()) {
      log.warn(`${this.name}: auth 不健康，嘗試刷新...`);
      const ok = await this.refreshAuth();
      if (!ok) {
        this._healthFails++;
        if (this._healthFails >= this._maxHealthFails) this.healthy = false;
        return false;
      }
    }

    try {
      const start = Date.now();
      const healthUrl = `${this.baseUrl}${this.healthEndpoint}`;
      const res = await fetch(healthUrl, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      const latency = Date.now() - start;
      if (res.ok) {
        this.lastLatency = latency;
        this.avgLatency = this.avgLatency
          ? this.avgLatency * 0.9 + latency * 0.1
          : latency;
        this._healthFails = 0;
        this.healthy = true;
        return true;
      }
      // 非 200 回應：記錄狀態碼（API 需要 auth）
      log.debug(`${this.name} health: HTTP ${res.status}`);
      this._healthFails++;
      if (this._healthFails >= this._maxHealthFails) this.healthy = false;
      return false;
    } catch (e) {
      this._healthFails++;
      if (this._healthFails >= this._maxHealthFails) this.healthy = false;
      return false;
    }
  }

  toJSON() {
    return {
      name: this.name,
      baseUrl: this.baseUrl,
      healthy: this.healthy,
      available: this.available,
      avgLatency: Math.round(this.avgLatency),
      consecutiveFails: this.consecutiveFails,
      circuitUntil: this.circuitUntil,
      successCount: this.successCount,
      failCount: this.failCount,
      lastError: this.lastError,
      priority: this.priority,
      healthFails: this._healthFails,
      auth: this.auth ? this.auth.toJSON() : null,
    };
  }
}
