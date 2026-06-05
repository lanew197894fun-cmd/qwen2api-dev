/**
 * provider.js — Provider 封裝層
 *
 * 每個 Provider 代表一個上游 API 端點，負責：
 * - 請求發送（post / get / stream）
 * - 健康追蹤（成功率、延遲、熔斷）
 * - 自動重試（依 HTTP 狀態碼區分）
 * - 電路熔斷器（連續失敗自動隔離）
 */

const log = {
  info: (...a) => console.log("[provider]", ...a),
  warn: (...a) => console.warn("[provider]", ...a),
  error: (...a) => console.error("[provider]", ...a),
  debug: (...a) => console.log("[provider]", ...a),
};

export class Provider {
  constructor(name, opts = {}) {
    this.name = name;
    this.baseUrl = opts.baseUrl || "";
    this.apiKey = opts.apiKey || "";
    this.timeout = opts.timeout || 120000;
    this.maxRetries = opts.retries ?? 1;
    this.priority = opts.priority ?? 1;
    this.weight = opts.weight ?? 1;

    // Auth integration
    this.auth = opts.auth || null;

    // Circuit breaker
    this.cbThreshold = opts.cbThreshold ?? 3;
    this.cbRecovery = opts.cbRecovery ?? 30000;

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

  /** 是否可用（僅電路熔斷影響可用性；健康檢查獨立追蹤不阻斷請求） */
  get available() {
    if (this.circuitUntil > Date.now()) return false;
    return true;
  }

  /** 記錄成功 */
  recordSuccess(latency) {
    this.successCount++;
    this.consecutiveFails = 0;
    this.circuitUntil = 0;
    this.healthy = true;
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
    if (this.consecutiveFails >= this.cbThreshold) {
      this.circuitUntil = Date.now() + this.cbRecovery;
      this.healthy = false;
      log.warn(
        `🔴 ${this.name}: 熔斷器觸發 (${this.consecutiveFails}次連續失敗，冷卻 ${this.cbRecovery / 1000}s)`,
      );
    }
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

        // HTTP 錯誤：判斷是否可重試
        if (this._isRetryable(res.status) && attempt < retries) {
          const wait = Math.min(2000 * 2 ** attempt, 10000);
          const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
          log.info(
            `[${trace}] ${this.name} HTTP ${res.status}，重試 ${attempt + 1}/${retries} (${jittered}ms)`,
          );
          await new Promise((r) => setTimeout(r, jittered));
          continue;
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
   */
  async stream(path, body, opts = {}) {
    const timeout = opts.timeout || this.timeout;
    const trace = opts.trace || "----";
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders();

    // 串流支援 401 retry（最多一次 auth refresh）
    for (let attempt = 0; attempt <= 1; attempt++) {
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

      this.recordFailure(`stream:HTTP ${status}`);
      try {
        const txt = await res.text();
        throw Object.assign(new Error(`HTTP ${status}: ${txt.slice(0, 200)}`), {
          status,
          body: txt.slice(0, 500),
        });
      } catch (e) {
        if (e.status) throw e;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }
    }
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
      const res = await fetch(`${this.baseUrl}/v1/models`, {
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
