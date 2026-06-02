/**
 * detect.ts — 環境自動偵測
 *
 * 啟動時自動判斷硬體等級與可用工具：
 *   - small  → 低配硬體，自動降載省資源
 *   - medium → 中等配置，平衡模式
 *   - large  → 高效能，全速運行
 *
 * 原則：有安裝才啟用功能，沒安裝安靜跳過
 */

import { cpus, totalmem, freemem, platform } from "os";
import { execSync } from "child_process";

const IS_WIN = platform() === "win32";

// ─── 安全執行命令，失敗不回拋 ───
// Platform-aware: Windows uses `nul`, Unix uses `/dev/null`

function tryExec(cmd: string, timeout = 3000): string | null {
  try {
    const c = IS_WIN ? cmd.replace(/\/dev\/null/g, "nul") : cmd;
    return execSync(c, { timeout, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ─── 結果型別 ───

export interface DetectResult {
  /** 硬體等級 */
  level: "small" | "medium" | "large";
  /** 建議輪詢間隔 (ms) */
  pollIntervalMs: number;
  /** 建議 Qwen 模型 */
  qwenModel: string;
  /** 是否啟用 peer 同步 */
  peerSync: boolean;
  /** Tailscale 已安裝 */
  tailscale: boolean;
  /** 同帳號有其他裝置在線 */
  tailscalePeers: boolean;
  /** 是否為筆電 */
  isLaptop: boolean;
  /** 是否使用電池 */
  onBattery: boolean;
  /** 詳細資訊（顯示用） */
  info: string;
}

// ─── 快取（30 秒內重複呼叫不回抓） ───

let cached: DetectResult | null = null;
let cacheTime = 0;
const TTL = 30_000;

// ─── 筆電判斷 ───

function detectLaptop(): { isLaptop: boolean; onBattery: boolean } {
  // Linux: /sys/class/power_supply/BAT* 存在 = 筆電
  const bats = tryExec("ls /sys/class/power_supply/BAT*/status 2>/dev/null");
  if (bats) {
    const st = tryExec("cat /sys/class/power_supply/BAT*/status 2>/dev/null");
    return {
      isLaptop: true,
      onBattery: st?.toLowerCase().includes("discharging") ?? false,
    };
  }
  // macOS: sysctl hw.model 含 "Book" = MacBook（Mac mini/iMac/Mac Pro 不含）
  const model = tryExec("sysctl -n hw.model 2>/dev/null");
  if (model && /book/i.test(model)) {
    const ac = tryExec("pmset -g batt 2>/dev/null | grep -c 'AC Power'");
    return {
      isLaptop: true,
      onBattery: ac === "0" || ac === null,
    };
  }
  return { isLaptop: false, onBattery: false };
}

// ─── Tailscale 偵測 ───
// 僅同帳號有 peer 裝置在線時才啟用同步

function detectTailscale(): { installed: boolean; hasPeers: boolean } {
  // Windows: where, Linux/Mac: which
  const whichCmd = IS_WIN
    ? "where tailscale 2>nul"
    : "which tailscale 2>/dev/null || command -v tailscale 2>/dev/null";
  const which = tryExec(whichCmd);
  if (!which) return { installed: false, hasPeers: false };
  // tailscale status 列出同帳號所有裝置
  const st = tryExec("tailscale status 2>/dev/null");
  if (!st) return { installed: true, hasPeers: false };
  // 至少 2 行 = 本機 + 至少一台 peer
  const lines = st.split("\n").filter(Boolean);
  const hasPeers = lines.length >= 2;
  return { installed: true, hasPeers };
}

// ─── CPU ───

function detectCpu(): { cores: number; model: string; score: number } {
  const cores = cpus().length;
  const model = cpus()[0]?.model ?? "unknown";
  const baseFreq = parseFloat(model.match(/(\d+\.?\d*)GHz/i)?.[1] ?? "0");
  let s = 0;
  if (cores >= 8) s = 3;
  else if (cores >= 4) s = 2;
  else s = 1;
  if (baseFreq >= 3.0) s += 1;
  else if (baseFreq < 2.0) s -= 1;
  return { cores, model, score: Math.max(1, Math.min(5, s)) };
}

// ─── RAM ───

function detectRam(): { totalGB: number; freeGB: number; score: number } {
  const totalGB = totalmem() / 1024 / 1024 / 1024;
  const freeGB = freemem() / 1024 / 1024 / 1024;
  let s = 0;
  if (totalGB >= 16) s = 3;
  else if (totalGB >= 8) s = 2;
  else if (totalGB >= 4) s = 1;
  if (freeGB >= 4) s += 1;
  return {
    totalGB: +totalGB.toFixed(1),
    freeGB: +freeGB.toFixed(1),
    score: Math.max(0, Math.min(4, s)),
  };
}

// ─── 系統負載 ───

function detectLoad(): { perCore: number; score: number } {
  const cores = cpus().length;
  try {
    const load = cpus().map((c) => {
      const times = c.times;
      const total =
        times.user + times.nice + times.sys + times.idle + times.irq;
      return 1 - times.idle / total;
    });
    // 取平均值
    const avg = load.reduce((a, b) => a + b, 0) / load.length;
    let s = 2;
    if (avg < 0.3) s = 3;
    else if (avg > 0.7) s = 1;
    return { perCore: +avg.toFixed(2), score: s };
  } catch {
    return { perCore: 0.5, score: 2 };
  }
}

// ─── 主偵測 ───

export function detect(): DetectResult {
  const now = Date.now();
  if (cached && now - cacheTime < TTL) return cached;

  const cpu = detectCpu();
  const ram = detectRam();
  const load = detectLoad();
  const laptop = detectLaptop();
  const hasTailscale = detectTailscale();

  const total = cpu.score + ram.score + load.score;

  // ── 判定等級 ──
  let level: "small" | "medium" | "large" = "medium";
  if (total <= 4) level = "small";
  else if (total >= 9) level = "large";

  // 記憶體不足強制降級
  if (ram.freeGB < 1.5) level = "small";
  // 筆電電池模式降級
  if (laptop.onBattery && level !== "small") {
    level = level === "large" ? "medium" : "small";
  }

  // ── 根據等級決定配置 ──
  const cfg = (() => {
    switch (level) {
      case "small":
        return { pollIntervalMs: 5_000, qwenModel: "small" };
      case "large":
        return { pollIntervalMs: 2_000, qwenModel: "large" };
      default:
        return { pollIntervalMs: 3_000, qwenModel: "small" };
    }
  })();

  // ── 資訊文字 ──
  const lines: string[] = [];
  lines.push(`🖥  ${cpu.model} (${cpu.cores}核)`);
  lines.push(`💾  RAM ${ram.totalGB}GB (可用 ${ram.freeGB}GB)`);
  lines.push(
    `🔌  ${laptop.isLaptop ? (laptop.onBattery ? "筆電·電池" : "筆電·電源") : "桌機"}`,
  );
  const tsStr = hasTailscale.installed
    ? hasTailscale.hasPeers
      ? "✅ 同帳號有 peer"
      : "⚠️ 僅本機"
    : "—";
  lines.push(`🌐  Tailscale ${tsStr}`);
  lines.push(
    `📊  等級: ${level === "small" ? "輕量" : level === "large" ? "高效" : "中等"} (評分 ${total}/12)`,
  );
  lines.push(`⚙️   輪詢 ${cfg.pollIntervalMs}ms · 模型 ${cfg.qwenModel}`);

  const result: DetectResult = {
    level,
    pollIntervalMs: cfg.pollIntervalMs,
    qwenModel: cfg.qwenModel,
    peerSync: hasTailscale.installed && hasTailscale.hasPeers,
    tailscale: hasTailscale.installed,
    tailscalePeers: hasTailscale.hasPeers,
    isLaptop: laptop.isLaptop,
    onBattery: laptop.onBattery,
    info: lines.join("\n"),
  };

  cached = result;
  cacheTime = now;
  return result;
}
