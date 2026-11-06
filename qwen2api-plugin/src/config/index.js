/**
 * config/index.js — 集中定義層
 *
 * 所有環境變數預設值、門檻值、路由策略常數統一管理。
 * 匯出 CFG 物件供其他模組導入。
 *
 * 使用方式：
 *   import { CFG } from "./config/index.js"
 *   if (CFG.ROUTE_ENABLED) ...
 */

import os from "node:os";

// ─── 跨平台目錄（集中管理於 config/paths.js）───
import { QWEN2API_DIR as _QWEN2API_DIR, SYSTEM_DIR } from "./paths.js";

// ─── 裝置角色自動偵測 ───
// 優先順序：環境變數 > CPU 型號 > 主機名關鍵字 > 預設
// CPU 型號為最關鍵判斷依據（Xeon/Epyc/Opteron → server）
export const DEVICE_ROLE = (() => {
  const env = (process.env.DEVICE_ROLE || "").toLowerCase();
  if (env === "laptop" || env === "desktop" || env === "server") return env;
  try {
    // 1. CPU 型號判斷（最高優先級）
    const cpus = os.cpus();
    if (cpus.length > 0) {
      const model = cpus[0].model.toLowerCase();
      if (/xeon|epyc|opteron/i.test(model)) return "server";
    }
    // 2. 主機名關鍵字判斷
    const h = os.hostname().toLowerCase();
    if (/aspire|laptop|notebook|thinkpad|macbook/i.test(h)) return "laptop";
    if (/server|host|desktop|tower|main|primary|rig/i.test(h)) return "server";
  } catch {}
  return "desktop";
})();

// 角色預設值（環境變數優先 → 角色預設 → 全域預設）
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
      // ═══ 逾時層級硬性規範（2026-11-01，見 docs/PLAN_UPSTREAM_TIMEOUT_WAF.md）═══
      // 推理時間較長時，三層計時器必須嚴格排序，否則請求計時器會先砍掉長推理：
      //   REQUEST_TIMEOUT >= THINKING_TIMEOUT > CHAT_IDLE_THINKING_MS
      // 舊值 60/60/120 導致 REQUEST(60s) < THINKING(120s)，推理超過 60s
      // 就被 AbortController.abort() 中斷 → 客戶端看到「上游無回應」。
      // IDLE(180s) 永遠碰不到，形同無效設定。
      style: "conservative",
      maxConcurrent: 2,
      downgradeThresholdMedium: 3,
      downgradeThresholdSmall: 6,
      cbThreshold: 10,
      cbRecoveryMs: 10000,
      healthTimeoutMs: 5000,
      requestTimeoutMs: 660000, // 最後防線 = thinking 600s + 60s 緩衝
      chatTimeoutMs: 300000, // 一般聊天 5 分鐘
      thinkingTimeoutMs: 600000, // thinking 模式 10 分鐘
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

const _ROLE_CFG = ROLE_DEFAULTS[DEVICE_ROLE] || {};
export const HW_PROFILE =
  _ROLE_CFG.HW_PROFILE || ROLE_DEFAULTS.desktop.HW_PROFILE;
export const ROUTE_STRATEGY =
  _ROLE_CFG.ROUTE_STRATEGY || ROLE_DEFAULTS.desktop.ROUTE_STRATEGY;

if (
  typeof process !== "undefined" &&
  process.env?.["PROXY_LOG_LEVEL"] !== "silent"
) {
  console.log(`[config] DEVICE_ROLE=${DEVICE_ROLE} hostname=${os.hostname()}`);
}

// ─── 伺服器基本設定 ───
export const CFG = {
  // 裝置角色
  DEVICE_ROLE,
  HW_PROFILE,
  ROUTE_STRATEGY,
  ROLE_DEFAULTS: _ROLE_CFG,

  // 埠號
  PROXY_PORT: parseInt(process.env.PROXY_PORT || "3456", 10),
  QWEN2API_PORT: parseInt(process.env.QWEN2API_PORT || "3000", 10),
  EMBED_PORT: parseInt(process.env.EMBED_PORT || "11436", 10),

  // 主機
  QWEN2API_HOST: process.env.QWEN2API_HOST || "127.0.0.1",

  // API
  API_KEY: process.env.API_KEY || _ROLE_CFG.API_KEY || "CHANGE_ME",
  MEMORY_BRIDGE_URL: process.env.MEMORY_BRIDGE_URL || "http://localhost:4377",

  // Body 上限 (bytes)
  MAX_BODY: parseInt(process.env.PROXY_MAX_BODY || "1048576", 10),

  // ─── Prompt 長度守門（2026-10-23 實測新增，2026-11-05 再收緊）───
  // 實測 qwen3.7-plus（走 chat.qwen.ai WAF）：
  //   32K tokens 正常；38K~42K 回 content:null（空回覆）；
  //   44K+ 直接觸發 waf_breaker_open（IP 級風控，重試必敗）。
  // 2026-11-05 實測（免額 qwen3.8-omni-flash + 53 tools）：
  //   8K/12K/16K → 正常發 tool_calls；22K → 退化（qwen3.8 只吐 bash 區塊、
  //   qwen3.7 直接幻覺「已修復」）。真實 opencode 請求常達 21K+，故上限降至 16000。
  // 注意：38K 回空、44K 觸發風控，勿再上調。
  PROMPT_TOKEN_LIMIT: parseInt(
    process.env.PROXY_PROMPT_TOKEN_LIMIT || "16000",
    10,
  ),
  PROMPT_KEEP_MSGS: parseInt(process.env.PROXY_PROMPT_KEEP_MSGS || "15", 10),

  // ─── 併發與限流 (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  // proxy 層入口最大併發數（超過直接 429）
  MAX_INFLIGHT: parseInt(
    process.env.PROXY_MAX_INFLIGHT || String(ROUTE_STRATEGY.maxInflight),
    10,
  ),
  // opencode LLM stream semaphore 最大併發
  LLM_MAX_CONCURRENT: parseInt(
    (typeof process !== "undefined"
      ? process.env.LLM_MAX_CONCURRENT
      : undefined) || String(ROUTE_STRATEGY.maxConcurrent),
    10,
  ),
  // semaphore acquire timeout (ms)
  LLM_ACQUIRE_TIMEOUT: parseInt(
    (typeof process !== "undefined"
      ? process.env.LLM_ACQUIRE_TIMEOUT
      : undefined) || "15000",
    10,
  ),

  // ─── 超時 (ms) (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  // 請求整體超時
  REQUEST_TIMEOUT: parseInt(
    process.env.PROXY_REQUEST_TIMEOUT ||
      String(ROUTE_STRATEGY.requestTimeoutMs),
    10,
  ),
  // 一般聊天超時
  CHAT_TIMEOUT: parseInt(
    process.env.PROXY_CHAT_TIMEOUT || String(ROUTE_STRATEGY.chatTimeoutMs),
    10,
  ),
  // thinking 模式超時
  THINKING_TIMEOUT: parseInt(
    process.env.PROXY_THINKING_TIMEOUT ||
      String(ROUTE_STRATEGY.thinkingTimeoutMs),
    10,
  ),
  // 健康檢查超時
  HEALTH_TIMEOUT: parseInt(
    process.env.PROXY_HEALTH_TIMEOUT || String(ROUTE_STRATEGY.healthTimeoutMs),
    10,
  ),

  // ─── 重試 (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  RETRIES: parseInt(
    process.env.PROXY_RETRIES || String(ROUTE_STRATEGY.retries),
    10,
  ),

  // ─── 熔斷器 (Circuit Breaker) (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  CB_THRESHOLD: parseInt(
    process.env.PROXY_CB_THRESHOLD || String(ROUTE_STRATEGY.cbThreshold),
    10,
  ),
  CB_RECOVERY_MS: parseInt(
    process.env.PROXY_CB_RECOVERY || String(ROUTE_STRATEGY.cbRecoveryMs),
    10,
  ),

  // ─── 速率限制 (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  RL_MAX: parseInt(
    process.env.PROXY_RATE_LIMIT || String(ROUTE_STRATEGY.rateLimitMax),
    10,
  ),
  RL_WIN: parseInt(
    process.env.PROXY_RATE_WINDOW || String(ROUTE_STRATEGY.rateLimitWindowMs),
    10,
  ),

  // ─── 模型路由 ───
  // 路由開關
  ROUTE_ENABLED: (process.env.PROXY_ROUTE || "auto") !== "off",
  // 推理模式
  THINKING_MODE: (process.env.PROXY_THINKING_MODE || "auto").toLowerCase(),
  // 強制硬體等級（空 = 自動偵測）
  HW_FORCE_LEVEL: (process.env.PROXY_HW_FORCE_LEVEL || "").toLowerCase(),

  // 模型覆寫
  MODEL_SMALL: process.env.PROXY_SMALL_MODEL || null,
  MODEL_MEDIUM: process.env.PROXY_MEDIUM_MODEL || null,
  MODEL_LARGE: process.env.PROXY_LARGE_MODEL || null,
  // 2026-11-05 Fix：qwen3.7-plus 在 53 tools 下必回 502 空內容（NO_TOOL_MODELS），
  // coder 任務必然帶 tools，故預設改用支援工具的 qwen3.6-plus。
  MODEL_CODER: process.env.PROXY_CODER_MODEL || "qwen3.6-plus",

  // 強制鎖定模型（繞過所有路由/偵測/降級邏輯）
  MODEL_FORCE: process.env.PROXY_FORCE_MODEL || null,

  // 模型預設值（envModels 偵測失敗時使用）
  // 注意：須與 qwen2api 現存模型一致。舊值 qwen3.6-max-preview 已從上游下架，
  // 沿用會導致偵測失敗時送出 404（2026-10-23 實測）。
  // 2026-11-05 Fix：medium/large 原為 qwen3.7-plus（NO_TOOL_MODELS，帶 tools 必 502），
  // 改為支援工具的 qwen3.6-plus；small 維持實測最穩的 qwen3.8-omni-flash。
  MODEL_DEFAULTS: {
    small: "qwen3.8-omni-flash",
    medium: "qwen3.6-plus",
    large: "qwen3.6-plus",
  },

  // ─── 負載路由降級 (依 ROUTE_STRATEGY 裝置角色動態調整) ───
  // 降級後冷卻時間 (ms)，才允許升級
  MODEL_COOLDOWN: parseInt(process.env.PROXY_MODEL_COOLDOWN || "10000", 10),
  // 降級門檻（proxyInflight >= ? 時觸發）
  DOWNGRADE_THRESHOLDS: {
    medium: ROUTE_STRATEGY.downgradeThresholdMedium,
    small: ROUTE_STRATEGY.downgradeThresholdSmall,
  },

  // ─── 對話記憶 ───
  CONV_MEMORY_ENABLED: process.env.PROXY_CONV_MEMORY !== "false",
  CONV_SUMMARY_INTERVAL: parseInt(
    process.env.PROXY_SUMMARY_INTERVAL || "5",
    10,
  ),
  CONV_RECENT_MSGS: parseInt(process.env.PROXY_RECENT_MSGS || "15", 10),
  CONV_MAX_HISTORY_TOKENS: parseInt(
    process.env.PROXY_MAX_HISTORY_TOKENS || "30000",
    10,
  ),
  CONV_SESSION_ID: process.env.PROXY_SESSION_ID || "default",
  CONV_HISTORY: process.env.PROXY_CONV_HISTORY !== "false",
  CONV_SRC: process.env.PROXY_CONV_SOURCE || "proxy",
  CONV_SESSION_SUFFIX: process.env.PROXY_CONV_SESSION || "opencode",

  // ─── 多 Provider 路由 ───
  PROVIDER_NAMES: (() => {
    const raw = process.env.PROVIDER_NAMES || "";
    return raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ["qwen2api"];
  })(),
  ROUTER_STRATEGY: (process.env.ROUTER_STRATEGY || "failover").toLowerCase(),
  ROUTER_HEALTH_ENABLED: process.env.ROUTER_HEALTH_ENABLED !== "false",
  ROUTER_HEALTH_INTERVAL: parseInt(
    process.env.ROUTER_HEALTH_INTERVAL || "30000",
    10,
  ),

  // ─── 多 Provider 認證 (Auth) ───
  // 每個 Provider 可獨立設定認證方式，透過環境變數：
  //   PROVIDER_<NAME>_AUTH_TYPE=api-key|oauth|cookie
  //   PROVIDER_<NAME>_AUTH_KEY=xxx           — api-key 的 key
  //   PROVIDER_<NAME>_AUTH_CLIENT_ID=xxx     — oauth clientId
  //   PROVIDER_<NAME>_AUTH_CLIENT_SECRET=xxx — oauth clientSecret
  //   PROVIDER_<NAME>_AUTH_TOKEN_URL=xxx     — oauth tokenUrl
  //   PROVIDER_<NAME>_AUTH_SCOPES=xxx        — oauth scopes
  //   PROVIDER_<NAME>_AUTH_SESSION_TOKEN=xxx — cookie sessionToken
  //   PROVIDER_<NAME>_AUTH_COOKIE_STRING=xxx — cookie cookieString
  //   PROVIDER_<NAME>_AUTH_LOGIN_URL=xxx     — cookie loginUrl
  //   PROVIDER_<NAME>_AUTH_USERNAME=xxx      — cookie username
  //   PROVIDER_<NAME>_AUTH_PASSWORD=xxx      — cookie password
  //   PROVIDER_<NAME>_AUTH_MODE=sessionToken|cookieString|login
  //
  // 若未設定任何 AUTH_* 變數，Provider 使用傳統的 apiKey 模式

  // ─── ChatGPT Provider 預設配置 ───
  PROVIDER_CHATGPT_KEY: process.env.PROVIDER_CHATGPT_KEY || "",
  PROVIDER_CHATGPT_TIMEOUT: parseInt(
    process.env.PROVIDER_CHATGPT_TIMEOUT || "120000",
    10,
  ),
  PROVIDER_CHATGPT_RETRIES: parseInt(
    process.env.PROVIDER_CHATGPT_RETRIES || "1",
    10,
  ),
  PROVIDER_CHATGPT_PRIORITY: parseInt(
    process.env.PROVIDER_CHATGPT_PRIORITY || "1",
    10,
  ),

  // ─── 請求追蹤 ───
  TRACE_ENABLED: process.env.PROXY_TRACE !== "false",

  // ─── 記憶體監控 ───
  MEM_WARN_THRESHOLD: parseFloat(process.env.PROXY_MEM_WARN || "0.85"),

  // ─── 非串流 Keepalive ───
  NONSTREAM_KEEPALIVE_INTERVAL: parseInt(
    process.env.PROXY_NONSTREAM_KEEPALIVE || "15000",
    10,
  ),

  // ─── 日誌 ───
  LOG_LEVEL: ((raw) => {
    const map = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
    if (raw && map[raw] !== undefined) return map[raw];
    if (process.env.PROXY_QUIET === "true" || process.env.PROXY_QUIET === "1")
      return 0;
    return 2; // 預設 warn
  })(process.env.PROXY_LOG_LEVEL),

  // ─── 硬體偵測門檻 (筆電環境：保守估計，優先穩定) ───
  HW_SCORE: {
    small: 6, // total ≤ 6 → small（筆電通常 8GB RAM，保留緩衝）
    large: 12, // total ≥ 12 → large（僅高階筆電或桌機）
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

  // 複雜度關鍵字
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

  // ─── 跨平台目錄（集中管理於 config/paths.js）───
  PATHS: {
    qwen2api: _QWEN2API_DIR,
    projectDir: SYSTEM_DIR,
  },
  // 環境變數對應鍵名（優先於 PATHS）
  PATH_ENV_MAP: {
    qwen2api: "QWEN2API_DIR",
    projectDir: "PROJECT_DIR",
  },
};

/**
 * 解析 qwen2api 目錄路徑
 * 優先順序：環境變數 QWEN2API_DIR → ROUTE_STRATEGY.PATHS → 編譯期預設
 */
export const getQwen2apiDir = () => {
  const envDir = process.env.QWEN2API_DIR || process.env.QWEN2API_PATH;
  if (envDir) return envDir;
  return CFG.PATHS.qwen2api;
};

/** 取得 HW_PROFILE 分數（環境變數可覆寫） */
export const getHwScore = () => {
  const force = process.env.PROXY_HW_FORCE_LEVEL;
  if (force === "small") return 4;
  if (force === "large") return 14;
  if (force === "medium") return 8;
  return HW_PROFILE.score;
};

// ─── 輔助函數 ───

/** Qwen2API 完整 URL */
export const qwen2apiUrl = (path = "") =>
  `http://${CFG.QWEN2API_HOST.includes(":") ? `[${CFG.QWEN2API_HOST}]` : CFG.QWEN2API_HOST}:${CFG.QWEN2API_PORT}${path}`;

/** 模型層級順序 */
export const LEVEL_ORDER = { small: 0, medium: 1, large: 2 };
export const LEVEL_LABELS = ["small", "medium", "large"];

/** 從模型名稱推斷能力等級 */
export const classifyModel = (name) => {
  const n = (name || "").toLowerCase();
  if (n.includes("235b") || n.includes("max") || n.includes("preview"))
    return "large";
  if (n.includes("plus") || n.includes("coder")) return "medium";
  if (n.includes("27b") || n.includes("flash") || n.includes("35b"))
    return "small";
  return "medium";
};

/** 判斷是否為 -coder 字尾變體 */
export const isCoderVariant = (id) => {
  const n = String(id || "");
  if (n.toLowerCase() === "qwen3-coder") return false;
  return /-(?:coder|thinking-coder|search-coder|thinking-search-coder)$/i.test(
    n,
  );
};

/**
 * 已知不支援 tools 的模型（2026-11-05 實測）。
 * qwen3.7-plus / qwen3.7-plus-thinking 在 53 tools 下上游必回
 * `upstream_502: upstream_empty_content`（0 tokens），無 tools 才正常。
 * 使用者明確指定這些模型但請求帶 tools 時，routeModel 會自動換成安全模型。
 */
export const NO_TOOL_MODELS = new Set([
  "qwen3.7-plus",
  "qwen3.7-plus-thinking",
]);
