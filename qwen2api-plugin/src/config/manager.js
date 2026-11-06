/**
 * config/manager.js — 統一配置管理器
 *
 * 功能：
 * • 集中管理所有環境變數與預設值
 * • 支援動態重載（無需重啟服務）
 * • 提供配置驗證與型別轉換
 * • 匯出單一 CFG 物件供全域使用
 *
 * 使用方式：
 *   import { CFG, reloadConfig } from "./config/manager.js"
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ─── 裝置角色自動偵測 ───
const detectDeviceRole = () => {
  const env = (process.env.DEVICE_ROLE || "").toLowerCase();
  if (["laptop", "desktop", "server"].includes(env)) return env;
  try {
    const cpus = os.cpus();
    if (cpus.length > 0) {
      const model = cpus[0].model.toLowerCase();
      if (/xeon|epyc|opteron/i.test(model)) return "server";
    }
    const h = os.hostname().toLowerCase();
    if (/aspire|laptop|notebook|thinkpad|macbook/i.test(h)) return "laptop";
    if (/server|host|desktop|tower|main|primary|rig/i.test(h)) return "server";
  } catch {}
  return "desktop";
};

// ─── 角色預設配置 ───
const ROLE_DEFAULTS = {
  laptop: {
    API_KEY: "sk-123456",
    HW_PROFILE: {
      label: "laptop",
      totalRAM_GB: 8,
      totalCPU: 4,
      gpuVRAM_GB: 0,
      score: 4,
    },
    ROUTE_STRATEGY: {
      style: "conservative",
      maxConcurrent: 2,
      downgradeThresholdMedium: 3,
      downgradeThresholdSmall: 6,
      cbThreshold: 10,
      cbRecoveryMs: 10000,
      healthTimeoutMs: 5000,
      requestTimeoutMs: 180000,
      chatTimeoutMs: 180000,
      thinkingTimeoutMs: 300000,
      retries: 1,
      rateLimitMax: 300,
      rateLimitWindowMs: 60000,
      maxInflight: 4,
    },
  },
  desktop: {
    API_KEY: "CHANGE_ME",
    HW_PROFILE: {
      label: "desktop",
      totalRAM_GB: 32,
      totalCPU: 16,
      gpuVRAM_GB: 0,
      score: 10,
    },
    ROUTE_STRATEGY: {
      style: "balanced",
      maxConcurrent: 3,
      downgradeThresholdMedium: 8,
      downgradeThresholdSmall: 16,
      cbThreshold: 10,
      cbRecoveryMs: 10000,
      healthTimeoutMs: 8000,
      requestTimeoutMs: 300000,
      chatTimeoutMs: 300000,
      thinkingTimeoutMs: 600000,
      retries: 2,
      rateLimitMax: 1200,
      rateLimitWindowMs: 60000,
      maxInflight: 32,
    },
  },
  server: {
    API_KEY: "CHANGE_ME",
    HW_PROFILE: {
      label: "server",
      totalRAM_GB: 64,
      totalCPU: 32,
      gpuVRAM_GB: 24,
      score: 20,
    },
    ROUTE_STRATEGY: {
      style: "aggressive",
      maxConcurrent: 8,
      downgradeThresholdMedium: 5,
      downgradeThresholdSmall: 10,
      cbThreshold: 15,
      cbRecoveryMs: 5000,
      healthTimeoutMs: 3000,
      requestTimeoutMs: 120000,
      chatTimeoutMs: 120000,
      thinkingTimeoutMs: 300000,
      retries: 2,
      rateLimitMax: 1200,
      rateLimitWindowMs: 60000,
      maxInflight: 16,
    },
  },
};

// ─── 跨平台目錄（集中管理於 config/paths.js）───
import { QWEN2API_DIR as _QWEN2API_DIR, SYSTEM_DIR } from "./paths.js";

// ─── 配置建構器 ───
const buildConfig = () => {
  const DEVICE_ROLE = detectDeviceRole();
  const _ROLE_CFG = ROLE_DEFAULTS[DEVICE_ROLE] || ROLE_DEFAULTS.desktop;
  const ROUTE_STRATEGY = _ROLE_CFG.ROUTE_STRATEGY;
  const HW_PROFILE = _ROLE_CFG.HW_PROFILE;

  // 輔助函數：安全解析整數
  const int = (envKey, defaultVal) => {
    const val = process.env[envKey];
    if (val === undefined || val === null || val === "") return defaultVal;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  };

  // 輔助函數：安全解析浮點數
  const float = (envKey, defaultVal) => {
    const val = process.env[envKey];
    if (val === undefined || val === null || val === "") return defaultVal;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultVal : parsed;
  };

  // 輔助函數：安全解析布林
  const bool = (envKey, defaultVal) => {
    const val = process.env[envKey];
    if (val === undefined || val === null || val === "") return defaultVal;
    return val.toLowerCase() === "true" || val === "1";
  };

  // 輔助函數：安全解析字串
  const str = (envKey, defaultVal) => {
    const val = process.env[envKey];
    if (val === undefined || val === null || val === "") return defaultVal;
    return val;
  };

  return {
    // 裝置角色
    DEVICE_ROLE,
    HW_PROFILE,
    ROUTE_STRATEGY,
    ROLE_DEFAULTS: _ROLE_CFG,

    // 埠號
    PROXY_PORT: int("PROXY_PORT", 3456),
    QWEN2API_PORT: int("QWEN2API_PORT", 3000),
    EMBED_PORT: int("EMBED_PORT", 11436),

    // 主機
    QWEN2API_HOST: str("QWEN2API_HOST", "127.0.0.1"),

    // API
    API_KEY: str("API_KEY", _ROLE_CFG.API_KEY || "CHANGE_ME"),
    MEMORY_BRIDGE_URL: str("MEMORY_BRIDGE_URL", "http://localhost:4377"),

    // Body 上限 (bytes)
    MAX_BODY: int("PROXY_MAX_BODY", 1048576),

    // ─── 併發與限流 ───
    MAX_INFLIGHT: int("PROXY_MAX_INFLIGHT", ROUTE_STRATEGY.maxInflight),
    LLM_MAX_CONCURRENT: int("LLM_MAX_CONCURRENT", ROUTE_STRATEGY.maxConcurrent),
    LLM_ACQUIRE_TIMEOUT: int("LLM_ACQUIRE_TIMEOUT", 15000),

    // ─── 超時 (ms) ───
    REQUEST_TIMEOUT: int(
      "PROXY_REQUEST_TIMEOUT",
      ROUTE_STRATEGY.requestTimeoutMs,
    ),
    CHAT_TIMEOUT: int("PROXY_CHAT_TIMEOUT", ROUTE_STRATEGY.chatTimeoutMs),
    THINKING_TIMEOUT: int(
      "PROXY_THINKING_TIMEOUT",
      ROUTE_STRATEGY.thinkingTimeoutMs,
    ),
    HEALTH_TIMEOUT: int("PROXY_HEALTH_TIMEOUT", ROUTE_STRATEGY.healthTimeoutMs),

    // ─── 重試 ───
    RETRIES: int("PROXY_RETRIES", ROUTE_STRATEGY.retries),

    // ─── 熔斷器 (Circuit Breaker) ───
    CB_THRESHOLD: int("PROXY_CB_THRESHOLD", ROUTE_STRATEGY.cbThreshold),
    CB_RECOVERY_MS: int("PROXY_CB_RECOVERY", ROUTE_STRATEGY.cbRecoveryMs),

    // ─── 速率限制 ───
    RL_MAX: int("PROXY_RATE_LIMIT", ROUTE_STRATEGY.rateLimitMax),
    RL_WIN: int("PROXY_RATE_WINDOW", ROUTE_STRATEGY.rateLimitWindowMs),

    // ─── 模型路由 ───
    ROUTE_ENABLED: str("PROXY_ROUTE", "auto") !== "off",
    THINKING_MODE: str("PROXY_THINKING_MODE", "auto").toLowerCase(),
    HW_FORCE_LEVEL: str("PROXY_HW_FORCE_LEVEL", "").toLowerCase(),

    // 模型覆寫
    MODEL_SMALL: str("PROXY_SMALL_MODEL", null),
    MODEL_MEDIUM: str("PROXY_MEDIUM_MODEL", null),
    MODEL_LARGE: str("PROXY_LARGE_MODEL", null),
    MODEL_CODER: str("PROXY_CODER_MODEL", "qwen3-coder"),

    // 模型預設值（須與 qwen2api MODEL_ALLOWLIST 一致）
    MODEL_DEFAULTS: {
      small: "qwen3.6-27b",
      medium: "qwen3.7-plus",
      large: "qwen3.7-max",
    },

    // ─── 負載路由降級 ───
    MODEL_COOLDOWN: int("PROXY_MODEL_COOLDOWN", 10000),
    DOWNGRADE_THRESHOLDS: {
      medium: ROUTE_STRATEGY.downgradeThresholdMedium,
      small: ROUTE_STRATEGY.downgradeThresholdSmall,
    },

    // ─── 對話記憶 ───
    CONV_MEMORY_ENABLED: bool("PROXY_CONV_MEMORY", true),
    CONV_SUMMARY_INTERVAL: int("PROXY_SUMMARY_INTERVAL", 5),
    CONV_RECENT_MSGS: int("PROXY_RECENT_MSGS", 15),
    CONV_MAX_HISTORY_TOKENS: int("PROXY_MAX_HISTORY_TOKENS", 30000),
    CONV_SESSION_ID: str("PROXY_SESSION_ID", "default"),
    CONV_HISTORY: bool("PROXY_CONV_HISTORY", true),
    CONV_SRC: str("PROXY_CONV_SOURCE", "proxy"),
    CONV_SESSION_SUFFIX: str("PROXY_CONV_SESSION", "opencode"),

    // ─── 多 Provider 路由 ───
    PROVIDER_NAMES: (() => {
      const raw = str("PROVIDER_NAMES", "");
      return raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["qwen2api", "chatgpt"];
    })(),
    ROUTER_STRATEGY: str("ROUTER_STRATEGY", "failover").toLowerCase(),
    ROUTER_HEALTH_ENABLED: bool("ROUTER_HEALTH_ENABLED", true),
    ROUTER_HEALTH_INTERVAL: int("ROUTER_HEALTH_INTERVAL", 30000),

    // ─── ChatGPT Provider 預設配置 ───
    PROVIDER_CHATGPT_KEY: str("PROVIDER_CHATGPT_KEY", ""),
    PROVIDER_CHATGPT_TIMEOUT: int("PROVIDER_CHATGPT_TIMEOUT", 120000),
    PROVIDER_CHATGPT_RETRIES: int("PROVIDER_CHATGPT_RETRIES", 1),
    PROVIDER_CHATGPT_PRIORITY: int("PROVIDER_CHATGPT_PRIORITY", 1),

    // ─── 請求追蹤 ───
    TRACE_ENABLED: bool("PROXY_TRACE", true),

    // ─── 記憶體監控 ───
    MEM_WARN_THRESHOLD: float("PROXY_MEM_WARN", 0.85),

    // ─── 非串流 Keepalive ───
    NONSTREAM_KEEPALIVE_INTERVAL: int("PROXY_NONSTREAM_KEEPALIVE", 15000),

    // ─── 日誌 ───
    LOG_LEVEL: (() => {
      const map = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
      const raw = str("PROXY_LOG_LEVEL", "warn");
      if (map[raw] !== undefined) return map[raw];
      if (bool("PROXY_QUIET", false)) return 0;
      return 2;
    })(),

    // ─── 硬體偵測門檻 ───
    HW_SCORE: {
      small: 6,
      large: 12,
    },

    // ─── 任務複雜度分析 ───
    COMPLEXITY: {
      LENGTH_WEIGHTS: [
        { min: 200, score: 1 },
        { min: 800, score: 2 },
        { min: 2000, score: 3 },
      ],
      TOOL_WEIGHTS: [
        { min: 1, score: 2 },
        { min: 5, score: 1 },
        { min: 10, score: 1 },
      ],
      TOOL_CHOICE_REQUIRED: 2,
      COMPLEX_KW_SCORE: 1,
      CHAIN_THOUGHT_SCORE: 2,
      THRESHOLD_LARGE: 5,
      THRESHOLD_MEDIUM: 2,
    },

    // 複雜度關鍵字（任務導向）
    COMPLEX_KEYWORDS: [
      "fix",
      "repair",
      "debug",
      "implement",
      "create",
      "build",
      "deploy",
      "refactor",
      "optimize",
      "analyze",
      "investigate",
      "troubleshoot",
      "修復",
      "除錯",
      "實作",
      "建立",
      "部署",
      "重構",
      "優化",
      "分析",
    ],

    // 認知理解關鍵字（意圖導向，觸發深度推理與 Large 模型路由）
    COGNITIVE_KEYWORDS: [
      "explain",
      "why",
      "how",
      "concept",
      "theory",
      "principle",
      "compare",
      "evaluate",
      "assess",
      "reasoning",
      "deduce",
      "interpret",
      "clarify",
      "解釋",
      "為什麼",
      "如何",
      "概念",
      "理論",
      "原理",
      "比較",
      "評估",
      "分析",
      "推論",
      "演繹",
      "詮釋",
      "釐清",
    ],

    // ─── 跨平台目錄（集中管理於 config/paths.js）───
    PATHS: {
      qwen2api: str("QWEN2API_DIR") || _QWEN2API_DIR,
      projectDir: str("PROJECT_DIR") || SYSTEM_DIR,
    },

    // ─── 自我進化系統 ───
    EVOLUTION_ENABLED: bool("PROXY_EVOLUTION", true),
    AUTO_ADJUST_THRESHOLDS: bool("PROXY_AUTO_ADJUST", true),
    EVOLUTION_INTERVAL_MS: int("PROXY_EVOLUTION_INTERVAL", 3600000), // 預設 1 小時檢查一次
  };
};

// ─── 匯出配置 ───
let CFG = buildConfig();

/**
 * 重新載入配置（從環境變數重新讀取）
 * @returns {Object} 新配置物件
 */
export const reloadConfig = () => {
  CFG = buildConfig();
  console.log(`[config] 配置已重載 (DEVICE_ROLE=${CFG.DEVICE_ROLE})`);
  return CFG;
};

/**
 * 取得目前配置
 * @returns {Object}
 */
export const getConfig = () => CFG;

// 預設匯出
export { CFG };
