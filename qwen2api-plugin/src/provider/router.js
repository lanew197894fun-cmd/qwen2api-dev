/**
 * router.js — 多 Provider 路由層
 *
 * 策略：
 *   failover    — 按優先級排序，失敗自動切換下一個
 *   priority    — 每次選最高優先級的健康 Provider
 *   latency     — 選平均延遲最低的健康 Provider
 *   round-robin — 輪詢所有健康 Provider
 *
 * 功能：
 * - select()     → 取得最佳 Provider
 * - exec()       → 自動 failover 執行請求
 * - startHealthChecks() → 背景健康監控
 */

const log = {
  info: (...a) => console.log("[router]", ...a),
  warn: (...a) => console.warn("[router]", ...a),
  error: (...a) => console.error("[router]", ...a),
};

const STRATEGIES = ["failover", "priority", "latency", "round-robin"];

export class Router {
  constructor(providers = [], strategy = "failover") {
    this.providers = providers;
    this.strategy = STRATEGIES.includes(strategy) ? strategy : "failover";
    this._rrIndex = 0;
    this._healthTimer = null;
  }

  /** 當前可用 Provider 列表 */
  get available() {
    return this.providers.filter((p) => p.available);
  }

  /** 選擇最佳單一 Provider */
  select() {
    const avail = this.available;
    if (avail.length === 0) return null;

    switch (this.strategy) {
      case "priority":
        return avail.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.avgLatency - b.avgLatency;
        })[0];

      case "latency":
        return avail.sort((a, b) => a.avgLatency - b.avgLatency)[0];

      case "round-robin":
        this._rrIndex = this._rrIndex % avail.length;
        return avail[this._rrIndex++ % avail.length];

      case "failover":
      default:
        return avail.sort((a, b) => a.priority - b.priority)[0];
    }
  }

  /** 建立嘗試鏈（依策略排序的 Provider 陣列） */
  selectChain() {
    const avail = this.available;
    if (avail.length === 0) return [];

    switch (this.strategy) {
      case "failover":
      case "priority":
        return avail.sort((a, b) => a.priority - b.priority);

      case "latency":
        return avail.sort((a, b) => a.avgLatency - b.avgLatency);

      case "round-robin":
        this._rrIndex = this._rrIndex % avail.length;
        const idx = this._rrIndex++;
        return [...avail.slice(idx), ...avail.slice(0, idx)];

      default:
        return avail;
    }
  }

  /**
   * 執行請求（自動 Provider 選擇 + failover）
   * 當前 Provider 失敗時自動嘗試下一個
   *
   * @param {"POST"|"GET"} method
   * @param {string} path  API 路徑
   * @param {object|null} body  POST body
   * @param {object} opts  timeout, retries, trace, headers
   * @returns {{ provider: string, data: any, latency: number }}
   */
  async exec(method, path, body, opts = {}) {
    const start = Date.now();
    const trace = opts.trace || "????";
    const candidates = opts.provider
      ? this.providers.filter((p) => p.name === opts.provider)
      : this.selectChain();

    if (candidates.length === 0) {
      throw new Error(`[${trace}] No available providers`);
    }

    const tried = new Set();
    let lastErr;

    for (const provider of candidates) {
      if (tried.has(provider.name)) continue;
      tried.add(provider.name);

      try {
        log.info(
          `[${trace}] 📡 ${method} ${path} → ${provider.name} (${provider.baseUrl})`,
        );

        let result;
        if (method === "POST") {
          result = await provider.post(path, body, opts);
        } else {
          result = await provider.get(path, opts);
        }

        const total = Date.now() - start;
        log.info(`[${trace}] ✅ ${provider.name} (${total}ms)`);
        return { provider: provider.name, data: result, latency: total };
      } catch (e) {
        lastErr = e;
        const msg = (e.message || "").slice(0, 120);
        log.warn(`[${trace}] ❌ ${provider.name}: ${msg}，嘗試下一個...`);
        // 繼續下一個 Provider
      }
    }

    const total = Date.now() - start;
    log.error(`[${trace}] 所有 Provider 均失敗 (${total}ms)`);
    throw lastErr || new Error(`[${trace}] All providers failed`);
  }

  /**
   * 串流執行 — 選 Provider 後回傳原始 Response
   * streamSinglePass 中直接 pipe
   */
  async execStream(path, body, opts = {}) {
    const trace = opts.trace || "????";
    const candidates = this.selectChain();

    if (candidates.length === 0) {
      throw new Error(`[${trace}] No available providers for stream`);
    }

    const tried = new Set();
    let lastErr;

    for (const provider of candidates) {
      if (tried.has(provider.name)) continue;
      tried.add(provider.name);

      try {
        log.info(
          `[${trace}] 📡 STREAM ${path} → ${provider.name} (${provider.baseUrl})`,
        );
        const res = await provider.stream(path, body, opts);
        return { provider: provider.name, response: res };
      } catch (e) {
        lastErr = e;
        const msg = (e.message || "").slice(0, 120);
        log.warn(
          `[${trace}] ❌ STREAM ${provider.name}: ${msg}，嘗試下一個...`,
        );
      }
    }

    throw lastErr || new Error(`[${trace}] All providers failed for stream`);
  }

  /** 啟動背景健康檢查 */
  startHealthChecks(intervalMs = 30000) {
    if (this._healthTimer) clearInterval(this._healthTimer);

    const check = async () => {
      for (const p of this.providers) {
        const prev = p.healthy;
        const ok = await p.checkHealth();
        if (prev !== p.healthy) {
          if (ok) log.info(`🟢 ${p.name}: 已恢復健康 (${p.baseUrl})`);
          else log.warn(`🔴 ${p.name}: 健康檢查失敗 (${p.baseUrl})`);
        }
      }
    };

    check(); // 立即執行一次
    this._healthTimer = setInterval(check, intervalMs);
  }

  stopHealthChecks() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /** 所有 Provider 狀態快照 */
  status() {
    return this.providers.map((p) => p.toJSON());
  }
}
