// governor.ts — 智慧調速引擎
// 追蹤 AI API 延遲 + 錯誤率 + 系統負載，動態調整節奏
// 無依賴，單例模組，可從 store/bot/processor 共用

import { loadavg, cpus } from "os";

// ── 狀態 ──

const apiLatencies: number[] = [];
const errorAt: number[] = [];
let inflight = 0;
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

export interface Suggestion {
  pollMs: number;
  skipBg: boolean;
  maxConc: number;
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

  // ── pollMs ──
  // 有 AI 回應但偏慢 → 降低 poll 頻率減少打擾
  // 系統忙碌或錯誤 → 大幅降頻
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

  info.push(`poll=${pollMs}ms`);
  if (skipBg) info.push("no-bg");
  info.push(`maxc=${maxConc}`);

  return { pollMs, skipBg, maxConc, info: info.join(" ") };
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
