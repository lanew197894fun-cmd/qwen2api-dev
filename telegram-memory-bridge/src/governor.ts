// governor.ts — 智慧調速引擎
// 追蹤 AI API 延遲 + 錯誤率 + 系統負載 + 佇列深度，動態調整節奏
// 無依賴，單例模組，可從 store/bot/processor 共用

import { loadavg, cpus } from "os";

// ── 狀態 ──

const apiLatencies: number[] = [];
const errorAt: number[] = [];
let inflight = 0;
let queueDepth = 0; // semaphore 等待佇列深度
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
  if (avg > 25_000 || load > 0.8 || recentErr >= 3) pollMs = 10_000;
  else if (avg > 15_000 || load > 0.65 || recentErr >= 2) pollMs = 6_000;
  else if (avg > 8_000 || load > 0.5 || recentErr >= 1) pollMs = 4_000;

  // ── skipBg ──
  const skipBg = load > 0.7 || avg > 18_000 || recentErr >= 2;

  // ── maxConc ──
  let maxConc = 3;
  if (avg > 18_000 || load > 0.7) maxConc = 1;
  else if (avg > 10_000 || load > 0.5) maxConc = 2;

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

  return {
    pollMs,
    skipBg,
    maxConc,
    modelTier,
    skipAIfIfTrivial,
    info: info.join(" "),
  };
}

// ── 系統負載偵測 ──

let lastLoadCheck = 0;
let cachedLoad = 0.3;

function getLoad(): number {
  const now = Date.now();
  if (now - lastLoadCheck < 10_000) return cachedLoad; // 10s 快取
  lastLoadCheck = now;
  try {
    const [load1] = loadavg();
    const cores = cpus().length;
    cachedLoad = cores > 0 ? load1 / cores : 0.3;
  } catch {
    cachedLoad = 0.3;
  }
  return cachedLoad;
}

// ── 主動監控服務 ──

let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 啟動 Governor 主動監控（每 10 秒採集指標並記錄）
 * @param intervalMs 採集間隔（預設 10000ms）
 */
export function startMonitoring(intervalMs = 10_000): void {
  if (monitorInterval) {
    console.warn("[governor] 監控已啟動，忽略重複呼叫");
    return;
  }

  console.log(`[governor] 啟動主動監控，間隔 ${intervalMs}ms`);
  monitorInterval = setInterval(() => {
    const s = suggest();
    // 僅在狀態變化時記錄，避免日誌洪水
    console.log(`[governor:tick] ${s.info}`);
  }, intervalMs);
}

/**
 * 停止 Governor 主動監控
 */
export function stopMonitoring(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log("[governor] 停止主動監控");
  }
}
