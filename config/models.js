/**
 * config/models.js — 跨裝置模型定義集中管理
 *
 * 功能：
 *   1. 根據硬體等級（small/medium/large）提供對應的預設模型
 *   2. 根據裝置角色（laptop/desktop）決定模型可用性（如 qwen3.7 系列）
 *   3. 支援環境變數強制覆寫（PROXY_SMALL_MODEL 等）
 *   4. 單一事實來源：chat-proxy.js 從此處讀取，確保雙機一致性
 *
 * 用法：
 *   import { getModelDefaults, getBadModels, getDeviceInfo } from "./config/models.js"
 */

import { platform } from "node:os";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { getCognition } from "./model-cognition.js";
import { getTargetOS } from "./paths.js";

const _IS_WIN = platform() === "win32";
// 跨裝置：使用者目標系統（決定路徑/模型選擇語意）
const _TARGET_OS = getTargetOS();

// ─── 快取 ───
let _deviceCache = null;
let _cacheTime = 0;
const _TTL = 60000; // 60 秒

/**
 * 取得裝置角色與硬體等級（純同步，無動態 import）
 * @returns {{ role: string, level: string, reason: string }}
 *
 * 角色：
 *   - desktop: 高效能桌機/伺服器，可跑大型模型
 *   - laptop: 筆電（含電池模式自動降級），節約資源
 *
 * 等級：
 *   - small:  輕量硬體 → 27B 以下模型
 *   - medium: 中階硬體 → Plus/32B 等級
 *   - large:  高效能硬體 → Max/235B 等級
 *
 * 跨裝置：
 *   - targetOS: 使用者當前所用系統（win/mac/linux），決定程式碼路徑語意
 *   - 與 hostOS（proxy 實際運行平台）不同時，路徑依 targetOS 切換
 */
export function getDeviceInfo() {
  const now = Date.now();
  if (_deviceCache && now - _cacheTime < _TTL) return _deviceCache;

  // 1. 環境變數強制指定優先
  const envRole = process.env.DEVICE_ROLE?.toLowerCase();
  if (envRole && ["laptop", "desktop"].includes(envRole)) {
    _deviceCache = {
      role: envRole,
      level: "medium",
      targetOS: _TARGET_OS,
      reason: "環境變數 DEVICE_ROLE",
    };
    _cacheTime = now;
    return _deviceCache;
  }

  // 2. 啟發式偵測（同步，無需動態載入）
  const isLaptop = _detectLaptop();
  const cpuCores = os.cpus().length;
  const totalGB = os.totalmem() / 1024 / 1024 / 1024;
  const level = _detectLevel(cpuCores, totalGB);

  _deviceCache = {
    role: isLaptop ? "laptop" : "desktop",
    level,
    targetOS: _TARGET_OS,
    reason: `啟發式 (${isLaptop ? "筆電" : "桌機"}, ${cpuCores}核, ${totalGB.toFixed(1)}GB) / 目標OS=${_TARGET_OS}`,
  };
  _cacheTime = now;
  return _deviceCache;
}

/**
 * 取得當前裝置適用的模型預設值
 * @param {string} [level] - 指定等級（small/medium/large），不指定則用裝置偵測結果
 * @param {object} [opts]  - { freeTierOnly: boolean }
 * @returns {{ small: string, medium: string, large: string }}
 */
export function getModelDefaults(level, opts = {}) {
  const info = level ? { role: getDeviceInfo().role, level } : getDeviceInfo();

  // 環境變數強制指定優先（PROXY_SMALL_MODEL、PROXY_MEDIUM_MODEL、PROXY_LARGE_MODEL）
  const fromEnv = {};
  for (const lvl of ["small", "medium", "large"]) {
    const envKey = `PROXY_${lvl.toUpperCase()}_MODEL`;
    if (process.env[envKey]) fromEnv[lvl] = process.env[envKey];
  }

  // ═══ Fix 2026-07-08: 免額模式 → 所有等級只用免額模型 ═══
  if (opts.freeTierOnly) {
    return {
      small: fromEnv.small || "qwen3.6-27b",
      medium: fromEnv.medium || "qwen3.6-27b",
      large: fromEnv.large || "qwen3.6-plus-thinking",
    };
  }

  // 桌機（高效能）— 允許更強大的模型
  const desktopDefaults = {
    small: fromEnv.small || "qwen3.6-27b",
    medium: fromEnv.medium || "qwen3.6-plus-thinking",
    large: fromEnv.large || "qwen3.6-max-preview",
  };

  // 筆電（保守）— qwen3.6-27b 為主，僅保留 qwen3.6-plus-thinking 給 large
  const laptopDefaults = {
    small: fromEnv.small || "qwen3.6-27b",
    medium: fromEnv.medium || "qwen3.6-27b",
    large: fromEnv.large || "qwen3.6-plus-thinking",
  };

  return info.role === "desktop" ? desktopDefaults : laptopDefaults;
}

/**
 * 取得當前裝置適用的永久黑名單（硬體無法負擔的模型）
 * 桌機：不封鎖任何模型（由 runtime 健康檢查自動處理）
 * 筆電：2026-07-08 解除 qwen3.7 封鎖（讓 FREE_TIER_ONLY 過濾器與健康檢查動態管理）
 *
 * @returns {string[]}
 */
export function getBadModels() {
  return [];
}

/**
 * 檢查給定模型是否應在當前裝置上被封鎖
 * @param {string} model
 * @returns {boolean}
 */
export function isBlockedOnDevice(model) {
  const n = (model || "").toLowerCase();
  const bad = getBadModels();
  return bad.some(
    (b) => n === b.toLowerCase() || n.startsWith(b.toLowerCase()),
  );
}

/**
 * 取得裝置摘要資訊（供日誌/健康檢查使用）
 */
export function getDeviceSummary() {
  const info = getDeviceInfo();
  const defs = getModelDefaults();
  const lines = [
    `🖥️ 裝置: ${info.role}  (等級: ${info.level})`,
    `   原因: ${info.reason}`,
    `   模型: small=${defs.small}, medium=${defs.medium}, large=${defs.large}`,
  ];
  const bad = getBadModels();
  if (bad.length > 0) {
    lines.push(`   封鎖: ${bad.length} 個模型 (硬體上限)`);
  } else {
    lines.push("   封鎖: 無 (由健康檢查動態管理)");
  }
  return lines.join("\n");
}

// ═══ 內部輔助（純同步） ═══

function _detectLaptop() {
  try {
    if (_IS_WIN) {
      const out = execSync(
        "wmic path Win32_Battery get BatteryStatus /format:csv 2>nul",
        { timeout: 2000, encoding: "utf8" },
      );
      return out.trim().split("\n").filter(Boolean).length > 1;
    }
    // Linux / macOS
    const bats = execSync(
      "ls /sys/class/power_supply/BAT* 2>/dev/null | head -1",
      { timeout: 2000, encoding: "utf8" },
    ).trim();
    return bats.length > 0;
  } catch {
    return false;
  }
}

function _detectLevel(cores, totalGB) {
  if (totalGB >= 12 && cores >= 6) return "large";
  if (totalGB >= 6 && cores >= 4) return "medium";
  return "small";
}

// ═══ Fix 5: 模型行為定義層 ═══
// 集中管理各模型的行為設定（逾時、重試、行為切換等），取代散落各處的硬編碼。
//
// 行為設定欄位：
//   timeout:    建議超時（ms），上游 API 逾時基底
//   retries:    空內容重試次數
//   tier:       效能等級（small/medium/large），影響降級路由
//   thinking:   是否預設啟用思考模式
//   noTool:     不支援工具調用（不上 tool-prompt）
//   unstable:   標記為不穩定（縮短閒置逾時）
//
// 模型規則比對：支援完全比對和前綴比對（如 qwen3.7 匹配所有 qwen3.7 變體）

const _MODEL_BEHAVIORS = [
  // ─── Qwen3.6 Max/Preview 系列（穩定大模型，認知強但慢） ───
  {
    match: /^qwen3[.-]?6[.-]?(max|preview)/i,
    behavior: {
      timeout: 180000,
      retries: 1,
      tier: "large",
      thinking: true,
      cognition: "powerful",
      noTool: false,
      unstable: false,
      // 連續空內容時強制切換 thinking 模式
      emptyAction: "enable_thinking",
    },
  },
  // ─── Qwen3.6 Plus 系列（平衡型，預設 thinking） ───
  {
    match: /^qwen3[.-]?6[.-]?plus/i,
    behavior: {
      timeout: 120000,
      retries: 2,
      tier: "medium",
      thinking: true,
      cognition: "balanced",
      noTool: false,
      unstable: false,
      emptyAction: "retry_thinking",
    },
  },
  // ─── 輕量模型（flash/27b/turbo） ───
  {
    match: /(?:flash|27b|turbo|nano|tiny|mini|lite)/i,
    behavior: {
      timeout: 60000,
      retries: 2,
      tier: "small",
      thinking: false,
      cognition: "lightweight",
      noTool: true,
      unstable: false,
      emptyAction: "skip",
    },
  },
  // ─── 推理模型（qwq 系列） ───
  {
    match: /qwq/i,
    behavior: {
      timeout: 180000,
      retries: 1,
      tier: "large",
      thinking: true,
      cognition: "reasoning",
      noTool: true,
      unstable: true,
      emptyAction: "switch_model",
    },
  },
  // ─── Coder 模型（編碼特化，需 thinking） ───
  {
    match: /coder/i,
    behavior: {
      timeout: 120000,
      retries: 2,
      tier: "medium",
      thinking: false, // 預設 false，但空內容時自動啟用
      cognition: "coding",
      noTool: false,
      unstable: false,
      emptyAction: "enable_thinking", // 空內容時啟用 thinking
    },
  },
  // ─── qwen3.7 系列（已知不穩定，短逾時+低重試） ───
  {
    match: /^qwen3[.-]?7/i,
    behavior: {
      timeout: 60000,
      retries: 0,
      tier: "medium",
      thinking: true,
      cognition: "unstable",
      noTool: false,
      unstable: true,
      emptyAction: "skip",
    },
  },
  // ─── qwen-max（通用別名） ───
  {
    match: /^qwen[-/]?max$/i,
    behavior: {
      timeout: 180000,
      retries: 1,
      tier: "large",
      thinking: true,
      cognition: "powerful",
      noTool: false,
      unstable: false,
      emptyAction: "enable_thinking",
    },
  },
  // ─── qwen-plus（通用別名） ───
  {
    match: /^qwen[-/]?plus$/i,
    behavior: {
      timeout: 120000,
      retries: 2,
      tier: "medium",
      thinking: true,
      cognition: "balanced",
      noTool: false,
      unstable: false,
      emptyAction: "retry_thinking",
    },
  },
  // ─── qwen-turbo（通用別名） ───
  {
    match: /^qwen[-/]?turbo$/i,
    behavior: {
      timeout: 60000,
      retries: 2,
      tier: "small",
      thinking: false,
      cognition: "lightweight",
      noTool: true,
      unstable: false,
      emptyAction: "skip",
    },
  },
];

const _DEFAULT_BEHAVIOR = {
  timeout: 120000,
  retries: 2,
  tier: "medium",
  thinking: false,
  unstable: false,
};

/**
 * 取得模型行為設定
 * @param {string} model - 模型名稱
 * @returns {{ timeout: number, retries: number, tier: string, thinking: boolean, unstable: boolean }}
 */
export function getModelBehavior(model) {
  if (!model) return { ..._DEFAULT_BEHAVIOR };
  for (const rule of _MODEL_BEHAVIORS) {
    if (rule.match.test(model)) {
      return { ..._DEFAULT_BEHAVIOR, ...rule.behavior };
    }
  }
  return { ..._DEFAULT_BEHAVIOR };
}

/**
 * 取得模型建議超時（疊加基底超時後取 max，確保至少等於基底）
 * @param {string} model
 * @param {number} baseTimeout - 依任務複雜度決定的基底超時
 * @returns {number}
 */
export function getModelTimeout(model, baseTimeout = 120000) {
  const bhv = getModelBehavior(model);
  return Math.max(baseTimeout, bhv.timeout);
}

/**
 * 取得模型空內容重試次數
 * @param {string} model
 * @returns {number}
 */
export function getModelRetries(model) {
  return getModelBehavior(model).retries;
}
