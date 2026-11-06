// governor.ts — 智慧調速引擎
// 追蹤 AI API 延遲 + 錯誤率 + 系統負載 + 佇列深度，動態調整節奏
// 無依賴，單例模組，可從 store/bot/processor 共用

import { cpus } from "os";

// ── Windows 相容 CPU 負載偵測 ──
// os.loadavg() 在 Windows 永遠回傳 [0,0,0]（Bun 也受影響）
// 改用 CPU 使用率採樣作為替代方案
let _cpuSamples: number[] = [];
let _lastCPUTime = getCPUTotal();
function getCPUTotal(): number {
  try {
    return cpus().reduce((s, c) => {
      const t = c.times;
      return s + t.user + t.nice + t.sys + t.idle + t.irq;
    }, 0);
  } catch {
    return 0;
  }
}
function sampleCPU(): number {
  try {
    const now = getCPUTotal();
    const idle = cpus().reduce((s, c) => s + c.times.idle, 0);
    const prevIdle = _lastCPUTime === 0 ? idle : idle;
    const totalDiff = now - _lastCPUTime;
    const idleDiff = idle - prevIdle;
    _lastCPUTime = now;
    if (totalDiff <= 0)
      return _cpuSamples.length > 0 ? _cpuSamples[_cpuSamples.length - 1] : 0.3;
    return 1 - idleDiff / totalDiff;
  } catch {
    return 0.3;
  }
}

// ── 狀態 ──

const apiLatencies: number[] = [];
const errorAt: number[] = [];
let inflight = 0;
let queueDepth = 0;
const MAX_SAMPLES = 20;

// ── API ──

export function recordApiCall(ms: number, ok: boolean): void {
  apiLatencies.push(ms);
  if (apiLatencies.length > MAX_SAMPLES) apiLatencies.shift();
  if (!ok) errorAt.push(Date.now());
}

export function startCall(): void {
  inflight++;
}

export function endCall(): void {
  if (inflight > 0) inflight--;
}

/** 由 semaphore 在入隊/出隊時呼叫 */
export function setQueueDepth(n: number): void {
  queueDepth = n;
}

export interface Suggestion {
  pollMs: number;
  skipBg: boolean;
  maxConc: number;
  /** 建議使用的模型等級 */
  modelTier: "small" | "medium" | "large";
  /** 極高負載時是否跳過 AI 回應（trivial 訊息直接回簡單確認） */
  skipAIfIfTrivial: boolean;
  info: string;
}

export function suggest(): Suggestion {
  const avg =
    apiLatencies.length > 0
      ? apiLatencies.reduce((a, b) => a + b, 0) / apiLatencies.length
      : 0;
  const recentErr = errorAt.filter((t) => Date.now() - t < 60_000).length;
  const load = getLoad();
  const info: string[] = [];

  if (avg > 0) info.push(`lat=${Math.round(avg)}ms`);
  info.push(`load=${load.toFixed(2)}`);
  info.push(`err=${recentErr}`);
  info.push(`inf=${inflight}`);
  info.push(`q=${queueDepth}`);

  // ── pollMs ──
  let pollMs = 2000;
  // 🐛 FIX: 進一步提高延遲閾值以適應 Max/Thinking 模型的長推理時間 (40-90s)
  if (avg > 90_000 || load > 0.95 || recentErr >= 4) pollMs = 15_000;
  else if (avg > 45_000 || load > 0.85 || recentErr >= 3) pollMs = 8_000;
  else if (avg > 20_000 || load > 0.7 || recentErr >= 2) pollMs = 5_000;

  // ── skipBg ──
  // P0 修復：收緊 queueDepth 保護閾值，避免 semaphore 滿載時仍接受請求
  // 原邏輯允許 queueDepth < 15 時繼續，但實際上 semaphore 在 depth >= 5 時已接近飽和
  const isBusyButHealthy = inflight > 0 && recentErr === 0 && queueDepth < 5;
  const skipBg =
    !isBusyButHealthy &&
    (load > 0.9 || avg > 90_000 || recentErr >= 4 || queueDepth >= 10);

  // ── maxConc ──
  let maxConc = 4; // P0: 提高基礎併發數以適應筆電低負載環境
  // 🐛 FIX: 進一步放寬併發限制，避免長推理任務時完全阻塞新請求
  if (avg > 120_000 || load > 0.95)
    maxConc = 2; // 極端延遲才降級
  else if (avg > 60_000 || load > 0.85) maxConc = 3;

  // ── modelTier — 依據負載 + 佇列深度動態降級 ──
  // 佇列深度權重：每 5 個排隊 +1 級降級
  const queuePenalty = Math.floor(queueDepth / 5);
  // 延遲權重：>15s +1 級，>30s +2 級
  const latPenalty = avg > 30_000 ? 2 : avg > 15_000 ? 1 : 0;
  // 錯誤權重
  const errPenalty = recentErr >= 3 ? 1 : 0;
  const totalPenalty = queuePenalty + latPenalty + errPenalty;

  let modelTier: "small" | "medium" | "large";
  if (totalPenalty >= 3) modelTier = "small";
  else if (totalPenalty >= 1) modelTier = "medium";
  else modelTier = "large";

  // ── skipAIfIfTrivial — 僅在極端情況下跳過 AI（避免誤判正常請求）─
  // 提高閾值：totalPenalty >= 4（原 3）且 queueDepth >= 20（原 10）
  const skipAIfIfTrivial =
    totalPenalty >= 4 || (queueDepth >= 20 && avg > 30_000);

  info.push(`poll=${pollMs}ms`);
  if (skipBg) info.push("no-bg");
  info.push(`maxc=${maxConc}`);
  info.push(`tier=${modelTier}`);
  if (skipAIfIfTrivial) info.push("skip-ai");
  if (totalPenalty >= 1) info.push(`penalty=${totalPenalty}`);

  return {
    pollMs,
    skipBg,
    maxConc,
    modelTier,
    skipAIfIfTrivial,
    info: info.join(" "),
  };
}

// ── 系統負載偵測（跨平台：Windows + Linux/macOS） ──

let lastLoadCheck = 0;
let cachedLoad = 0.3;

function getLoad(): number {
  const now = Date.now();
  if (now - lastLoadCheck < 10_000) return cachedLoad;
  lastLoadCheck = now;
  try {
    const load = sampleCPU();
    _cpuSamples.push(load);
    if (_cpuSamples.length > 5) _cpuSamples.shift();
    cachedLoad = _cpuSamples.reduce((a, b) => a + b, 0) / _cpuSamples.length;
  } catch {
    cachedLoad = 0.3;
  }
  return cachedLoad;
}

// ── 主動監控服務 ──
// P33 修復：使用 globalThis 跨模組儲存 interval ID
// 熱重載時新模組可清除舊模組殘留的 interval，防止泄漏
const GOV_MONITOR_KEY = "__governorMonitorInterval";

let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 啟動 Governor 主動監控（每 10 秒採集指標並記錄）
 * @param intervalMs 採集間隔（預設 10000ms）
 */
export function startMonitoring(intervalMs = 10_000): void {
  // 清除熱重載殘留的舊 interval
  const existing = (globalThis as any)[GOV_MONITOR_KEY];
  if (existing) {
    clearInterval(existing);
    console.warn("[governor] 清除殘留監控 interval (hot-reload)");
  }

  if (monitorInterval) {
    console.warn("[governor] 監控已啟動，忽略重複呼叫");
    return;
  }

  console.log(`[governor] 啟動主動監控，間隔 ${intervalMs}ms`);
  const id = setInterval(() => {
    const s = suggest();
    // 已禁用常規 tick 日誌，僅在 debug 模式下開啟
    // console.log(`[governor:tick] ${s.info}`);
  }, intervalMs);
  monitorInterval = id;
  (globalThis as any)[GOV_MONITOR_KEY] = id;
}

/**
 * 停止 Governor 主動監控
 */
export function stopMonitoring(): void {
  const id = (globalThis as any)[GOV_MONITOR_KEY];
  if (id) {
    clearInterval(id);
    (globalThis as any)[GOV_MONITOR_KEY] = null;
  }
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log("[governor] 停止主動監控");
}
