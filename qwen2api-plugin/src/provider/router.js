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

import { makeLogger } from "../color.js";
import { Provider } from "./provider.js";
const log = makeLogger("router", "info");

const STRATEGIES = [
  "failover",
  "priority",
  "latency",
  "round-robin",
  "adaptive",
];

export class Router {
  constructor(providers = [], strategy = "failover") {
    this.providers = providers;
    this.strategy = STRATEGIES.includes(strategy) ? strategy : "failover";
    this._rrIndex = 0;
    this._healthTimer = null;
    // adaptive 策略追蹤各 Provider 即時表現
    this._adaptiveStats = new Map();
    // Fix 2: 429 專屬冷卻追蹤（指數退避）
    this._rateLimitCooloff = new Map(); // name → { count, cooloffUntil }
    // 2026-07-13: 免額耗盡標示節流 — 首次一次報告，接近重置才再廣播
    this._quotaReported = new Map(); // name → { firstAt, nearAt }
  }

  /** 記錄 Provider 呼叫結果（供 adaptive 策略使用） */
  recordResult(name, latencyMs, success, rateLimited = false) {
    let s = this._adaptiveStats.get(name);
    const now = Date.now();
    const WINDOW_MS = 300000; // 5 分鐘滑動窗口
    if (!s || now - s.windowStart > WINDOW_MS) {
      s = {
        calls: 0,
        failures: 0,
        rateLimited: 0,
        lastRateLimitAt: 0,
        totalLatency: 0,
        windowStart: now,
        lastError: "",
      };
    }
    s.calls++;
    s.totalLatency += latencyMs;
    if (rateLimited) {
      s.rateLimited++;
      s.lastRateLimitAt = now;
      // Fix 2: 更新 429 冷卻（指數退避）
      this._record429(name, now);
    } else if (!success) {
      s.failures++;
    } else {
      // Fix 2: 成功時減半冷卻
      this._halveRateLimitCooloff(name);
    }
    this._adaptiveStats.set(name, s);
  }

  /** Fix 2: 429 指數退避：2s → 4s → 8s → ... → 30s max */
  _record429(name, now) {
    let c = this._rateLimitCooloff.get(name);
    const baseDelay = 2000; // 2s 基礎延遲
    const maxDelay = 30000; // 30s 最大延遲
    if (!c) {
      c = { count: 0, cooloffUntil: 0 };
    }
    c.count++;
    const delay = Math.min(baseDelay * Math.pow(2, c.count - 1), maxDelay);
    c.cooloffUntil = now + delay;
    log.info(
      `[429-backoff] ${name} 第 ${c.count} 次 429，冷卻 ${delay}ms (至 ${new Date(c.cooloffUntil).toISOString().slice(11, 19)})`,
    );
    this._rateLimitCooloff.set(name, c);
  }

  /** Fix 2: 成功時減半冷卻 */
  _halveRateLimitCooloff(name) {
    const c = this._rateLimitCooloff.get(name);
    if (c && c.count > 0) {
      c.count = Math.max(0, Math.floor(c.count / 2));
      // 若 count 降為 0，清除冷卻記錄
      if (c.count === 0) {
        this._rateLimitCooloff.delete(name);
      } else {
        this._rateLimitCooloff.set(name, c);
      }
    }
  }

  /** Fix 2: Provider 是否仍在 429 限流冷卻中（使用指數退避） */
  _isRateLimited(provider, now) {
    // 先檢查專屬冷卻
    const c = this._rateLimitCooloff.get(provider.name);
    if (c && now < c.cooloffUntil) {
      return true;
    }
    // 如果專屬冷卻已過期但還有記錄，清除之
    if (c) {
      this._rateLimitCooloff.delete(provider.name);
    }
    // fallback: 檢查 adaptiveStats 中的傳統限流標記（60s 窗口）
    const s = this._adaptiveStats.get(provider.name);
    if (!s || s.rateLimited === 0) return false;
    return now - s.lastRateLimitAt < 60000;
  }

  /**
   * 計算 Provider 的 adaptive 得分（0-100）
   * 成功率佔 50%，延遲佔 20%，429 懲罰佔 30%（每 429 扣 30 分）
   */
  _adaptiveScore(provider, now) {
    const s = this._adaptiveStats.get(provider.name);
    if (!s || s.calls === 0) {
      return Math.max(0, 100 - (provider.priority - 1) * 30);
    }
    const WINDOW_MS = 300000;
    if (now - s.windowStart > WINDOW_MS) {
      return Math.max(0, 100 - (provider.priority - 1) * 30);
    }
    const successRate = 1 - s.failures / Math.max(s.calls, 1);
    const avgLatency = s.totalLatency / s.calls;
    const latencyScore = Math.max(0, 1 - (avgLatency - 2000) / 13000);
    // 429 懲罰：每 429 扣 30 分，最多扣到 0
    const rateLimitPenalty = Math.min(s.rateLimited * 30, 100);
    return Math.max(
      0,
      (successRate * 0.5 + latencyScore * 0.2) * 100 - rateLimitPenalty * 0.3,
    );
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

      case "adaptive": {
        // 根據即時成功率與延遲動態排序
        const now = Date.now();
        return avail.sort((a, b) => {
          const sa = this._adaptiveScore(a, now);
          const sb = this._adaptiveScore(b, now);
          return sb - sa; // 高分優先
        })[0];
      }

      case "failover":
      default:
        return avail.sort((a, b) => a.priority - b.priority)[0];
    }
  }

  /** 建立嘗試鏈（依策略排序的 Provider 陣列） */
  selectChain() {
    const avail = this.available;
    if (avail.length === 0) return [];

    let chain;
    switch (this.strategy) {
      case "failover":
      case "priority":
        chain = avail.sort((a, b) => a.priority - b.priority);
        break;

      case "latency":
        chain = avail.sort((a, b) => a.avgLatency - b.avgLatency);
        break;

      case "round-robin":
        this._rrIndex = this._rrIndex % avail.length;
        const idx = this._rrIndex++;
        chain = [...avail.slice(idx), ...avail.slice(0, idx)];
        break;

      case "adaptive": {
        // adaptive chain — 高分優先嘗試
        const now = Date.now();
        chain = avail.sort((a, b) => {
          const sa = this._adaptiveScore(a, now);
          const sb = this._adaptiveScore(b, now);
          return sb - sa;
        });
        break;
      }

      default:
        chain = avail;
    }

    // 輸出 provider 狀態日誌（限流/熔斷）
    const now = Date.now();
    for (const p of chain) {
      const s = this._adaptiveStats.get(p.name);
      const rl = s && s.rateLimited > 0 && now - s.lastRateLimitAt < 120000;
      const cb = p.circuitUntil > now;
      if (rl || cb) {
        log.info(
          `  provider ${p.name}:${rl ? " ⏳429" : ""}${cb ? " 🔴cb" : ""} score=${Math.round(this._adaptiveScore(p, now))}`,
        );
      }
    }

    return chain;
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
    let allRatedLimited = true;
    const now = Date.now();

    for (const provider of candidates) {
      if (tried.has(provider.name)) continue;
      tried.add(provider.name);

      // 跳過仍在限流冷卻中的 Provider
      if (this._isRateLimited(provider, now)) {
        log.info(`[${trace}] ⏳ ${provider.name} 429 冷卻中，跳過`);
        continue;
      }
      // ═══ 免額耗盡：功能保留（跳過），日誌靜默（不重置，warn 輸出無意義）═══
      if (provider.quotaExhaustedUntil > now) {
        continue;
      } else if (this._quotaReported.has(provider.name)) {
        this._quotaReported.delete(provider.name);
      }
      allRatedLimited = false;

      try {
        log.info(
          `[${trace}] 📡 ${method} ${path} → ${provider.name} (${provider.baseUrl})`,
        );
        const attemptStart = Date.now();

        let result;
        if (method === "POST") {
          result = await provider.post(path, body, opts);
        } else {
          result = await provider.get(path, opts);
        }

        const total = Date.now() - start;
        const attemptLatency = Date.now() - attemptStart;
        // 記錄成功結果供 adaptive 策略使用
        this.recordResult(provider.name, attemptLatency, true);
        log.info(`[${trace}] ✅ ${provider.name} (${total}ms)`);
        return { provider: provider.name, data: result, latency: total };
      } catch (e) {
        lastErr = e;
        // 2026-10-21: chat challenge 為出口 IP 級風控，其他 Provider（同 IP）必敗 → 立即中止
        if (e.challenge) {
          log.warn(`[${trace}] 🛡️ ${provider.name} chat challenge → 中止 failover`);
          throw e;
        }
        const msg = (e.message || "").slice(0, 120);
        const is429 =
          e.status === 429 ||
          (e.message || "").includes("429") ||
          (e.body && String(e.body).includes("429"));
        // ═══ 免額耗盡失敗：功能保留（failover），日誌靜默 ═══
        if (e.quota) {
          continue;
        }
        // 記錄失敗結果供 adaptive 策略使用，標記 rateLimited
        this.recordResult(provider.name, Date.now() - start, false, is429);
        log.warn(
          `[${trace}] ❌ ${provider.name}: ${msg}${is429 ? " (429 限流)" : ""}，嘗試下一個...`,
        );
        // 繼續下一個 Provider
      }
    }

    const total = Date.now() - start;
    if (allRatedLimited) {
      log.error(`[${trace}] 所有 Provider 均 429 限流 (${total}ms)`);
      const err = new Error(`[${trace}] All providers rate limited`);
      err.status = 429;
      err.allRateLimited = true;
      throw err;
    }
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
    let allRatedLimited = true;
    const now = Date.now();

    for (const provider of candidates) {
      if (tried.has(provider.name)) continue;
      tried.add(provider.name);

      // 跳過仍在限流冷卻中的 Provider
      if (this._isRateLimited(provider, now)) {
        log.info(`[${trace}] ⏳ STREAM ${provider.name} 429 冷卻中，跳過`);
        continue;
      }
      allRatedLimited = false;

      try {
        log.info(
          `[${trace}] 📡 STREAM ${path} → ${provider.name} (${provider.baseUrl})`,
        );
        const attemptStart = Date.now();
        const res = await provider.stream(path, body, opts);
        // 串流建置成功即記錄（串流中斷由呼叫端處理）
        this.recordResult(provider.name, Date.now() - attemptStart, true);
        return { provider: provider.name, response: res };
      } catch (e) {
        lastErr = e;
        // 2026-10-21: chat challenge 為出口 IP 級風控 → 中止 failover（同 IP 必敗）
        if (e.challenge) {
          log.warn(
            `[${trace}] 🛡️ STREAM ${provider.name} chat challenge → 中止 failover`,
          );
          throw e;
        }
        const msg = (e.message || "").slice(0, 120);
        const is429 =
          e.status === 429 ||
          (e.message || "").includes("429") ||
          (e.body && String(e.body).includes("429"));
        // 記錄串流失敗供 adaptive 策略使用
        this.recordResult(provider.name, Date.now() - now, false, is429);
        log.warn(
          `[${trace}] ❌ STREAM ${provider.name}: ${msg}${is429 ? " (429 限流)" : ""}，嘗試下一個...`,
        );
      }
    }

    if (allRatedLimited) {
      const err = new Error(`[${trace}] All providers rate limited for stream`);
      err.status = 429;
      err.allRateLimited = true;
      throw err;
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
    const now = Date.now();
    return this.providers.map((p) => {
      const s = p.toJSON ? p.toJSON() : { name: p.name, healthy: p.healthy };
      const c = this._rateLimitCooloff.get(p.name);
      if (c) {
        s.rateLimitCooloff = {
          count: c.count,
          remaining: Math.max(0, c.cooloffUntil - now),
        };
      }
      return s;
    });
  }

  /** 429 冷卻狀態快照 */
  rateLimitStatus() {
    const now = Date.now();
    const out = {};
    for (const [name, c] of this._rateLimitCooloff) {
      out[name] = {
        count: c.count,
        remaining: Math.max(0, c.cooloffUntil - now),
      };
    }
    return out;
  }

  // ═══════════════════════════════════════════════
  // 動態 Provider 管理（執行中切換）
  // ═══════════════════════════════════════════════

  /**
   * 取得所有 Provider 的序列化資訊（供 API/工具查詢）
   * @returns {object[]}
   */
  getProvidersInfo() {
    const now = Date.now();
    return this.providers.map((p) => {
      const s = p.toJSON ? p.toJSON() : { name: p.name, healthy: p.healthy };
      const rl = this._rateLimitCooloff.get(p.name);
      const adapt = this._adaptiveStats.get(p.name);
      return {
        ...s,
        rateLimitCooloff: rl
          ? { count: rl.count, remaining: Math.max(0, rl.cooloffUntil - now) }
          : null,
        adaptiveScore: adapt ? Math.round(this._adaptiveScore(p, now)) : null,
        adaptiveCalls: adapt?.calls || 0,
        adaptiveFailures: adapt?.failures || 0,
      };
    });
  }

  /**
   * 動態新增 Provider
   * @param {string} name  Provider 唯一名稱
   * @param {object} opts  { baseUrl, apiKey, auth, priority, timeout, retries, weight, cbThreshold, cbRecovery }
   * @returns {boolean}  是否成功新增
   */
  addProvider(name, opts = {}) {
    // 檢查是否已存在同名 provider
    if (this.providers.some((p) => p.name === name)) {
      log.warn(`Provider "${name}" 已存在，使用 updateProvider 更新`);
      return false;
    }

    const provider = new Provider(name, {
      baseUrl: opts.baseUrl || "",
      apiKey: opts.apiKey || "",
      auth: opts.auth || null,
      priority: opts.priority ?? 1,
      timeout: opts.timeout || 120000,
      retries: opts.retries ?? 1,
      weight: opts.weight ?? 1,
      cbThreshold: opts.cbThreshold ?? 3,
      cbRecovery: opts.cbRecovery ?? 5000,
    });

    this.providers.push(provider);
    this._adaptiveStats.set(name, {
      calls: 0,
      failures: 0,
      rateLimited: 0,
      lastRateLimitAt: 0,
      totalLatency: 0,
      windowStart: Date.now(),
      lastError: "",
    });

    log.info(
      `✅ Provider "${name}" 已動態新增 (${opts.baseUrl}, pri=${provider.priority})`,
    );
    return true;
  }

  /**
   * 動態移除 Provider
   * @param {string} name
   * @returns {boolean}
   */
  removeProvider(name) {
    const idx = this.providers.findIndex((p) => p.name === name);
    if (idx === -1) {
      log.warn(`Provider "${name}" 不存在，無法移除`);
      return false;
    }

    // 確保至少留一個 Provider
    if (this.providers.length <= 1) {
      log.warn(`❌ 無法移除最後一個 Provider "${name}"`);
      return false;
    }

    this.providers.splice(idx, 1);
    this._adaptiveStats.delete(name);
    this._rateLimitCooloff.delete(name);

    log.info(`✅ Provider "${name}" 已移除`);
    return true;
  }

  /**
   * 動態更新 Provider 配置
   * 僅更新傳入的欄位，其餘保留
   * @param {string} name
   * @param {object} opts   { baseUrl?, apiKey?, priority?, timeout?, retries?, weight? }
   * @returns {boolean}
   */
  updateProvider(name, opts = {}) {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider) {
      log.warn(`Provider "${name}" 不存在，無法更新`);
      return false;
    }

    const changed = [];
    if (opts.baseUrl !== undefined) {
      provider.baseUrl = opts.baseUrl;
      changed.push("baseUrl");
    }
    if (opts.apiKey !== undefined) {
      provider.apiKey = opts.apiKey;
      changed.push("apiKey");
    }
    if (opts.priority !== undefined) {
      provider.priority = opts.priority;
      changed.push("priority");
    }
    if (opts.timeout !== undefined) {
      provider.timeout = opts.timeout;
      changed.push("timeout");
    }
    if (opts.retries !== undefined) {
      provider.maxRetries = opts.retries;
      changed.push("retries");
    }
    if (opts.weight !== undefined) {
      provider.weight = opts.weight;
      changed.push("weight");
    }
    // 重置熔斷器（便於切換後立刻可用）
    if (opts.resetCircuit !== false) {
      provider.consecutiveFails = 0;
      provider.circuitUntil = 0;
      provider.healthy = true;
      this._rateLimitCooloff.delete(name);
      changed.push("circuitReset");
    }

    log.info(`🔄 Provider "${name}" 已更新: ${changed.join(", ")}`);
    return true;
  }

  /**
   * 強制切換到指定 Provider（設定最高優先級）
   * @param {string} name
   * @returns {boolean}
   */
  switchTo(name) {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider) {
      log.warn(`Provider "${name}" 不存在，無法切換`);
      return false;
    }

    // 將指定 provider 設為最高優先級，其餘降級
    for (const p of this.providers) {
      if (p.name === name) {
        p.priority = 0;
      } else if (p.priority === 0) {
        // 避免其他 provider 也為 0
        p.priority = 10;
      }
    }

    // 重置指定 provider 的健康狀態
    provider.consecutiveFails = 0;
    provider.circuitUntil = 0;
    provider.healthy = true;
    this._rateLimitCooloff.delete(name);

    log.info(`🎯 已切換至 Provider "${name}" (優先級設為 0)`);
    return true;
  }

  /**
   * 取得首次請求的目標 Provider 名稱
   * @returns {string|null}
   */
  getActiveProviderName() {
    const sel = this.select();
    return sel ? sel.name : null;
  }
}
