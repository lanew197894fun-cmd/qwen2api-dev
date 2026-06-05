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

// ─── 伺服器基本設定 ───
export const CFG = {
  // 埠號
  PROXY_PORT: parseInt(process.env.PROXY_PORT || "3456", 10),
  QWEN2API_PORT: parseInt(process.env.QWEN2API_PORT || "3000", 10),
  WAF_PORT: parseInt(process.env.WAF_PORT || "3457", 10),
  EMBED_PORT: parseInt(process.env.EMBED_PORT || "11436", 10),

  // 主機
  QWEN2API_HOST: process.env.QWEN2API_HOST || "127.0.0.1",

  // API
  API_KEY: process.env.API_KEY || "CHANGE_ME",
  MEMORY_BRIDGE_URL: process.env.MEMORY_BRIDGE_URL || "http://localhost:4377",

  // Body 上限 (bytes)
  MAX_BODY: parseInt(process.env.PROXY_MAX_BODY || "1048576", 10),

  // ─── 併發與限流 (筆電開發測試優化：輕量、穩定) ───
  // proxy 層入口最大併發數（超過直接 429，降低至 2 避免上游擁塞）
  MAX_INFLIGHT: parseInt(process.env.PROXY_MAX_INFLIGHT || "2", 10),
  // opencode LLM stream semaphore 最大併發
  LLM_MAX_CONCURRENT: parseInt(
    (typeof process !== "undefined"
      ? process.env.LLM_MAX_CONCURRENT
      : undefined) || "1",
    10,
  ),
  // semaphore acquire timeout (ms)
  LLM_ACQUIRE_TIMEOUT: parseInt(
    (typeof process !== "undefined"
      ? process.env.LLM_ACQUIRE_TIMEOUT
      : undefined) || "15000",
    10,
  ),

  // ─── 超時 (ms) (筆電開發測試優化：快速失敗、避免卡死) ───
  // 請求整體超時（預設 30s，筆電環境避免長時間佔用資源）
  REQUEST_TIMEOUT: parseInt(process.env.PROXY_REQUEST_TIMEOUT || "30000", 10),
  // 一般聊天超時（縮短至 2min，避免無回應時無限等待）
  CHAT_TIMEOUT: parseInt(process.env.PROXY_CHAT_TIMEOUT || "120000", 10),
  // thinking 模式超時（縮短至 3min）
  THINKING_TIMEOUT: parseInt(
    process.env.PROXY_THINKING_TIMEOUT || "180000",
    10,
  ),
  // 健康檢查超時
  HEALTH_TIMEOUT: parseInt(process.env.PROXY_HEALTH_TIMEOUT || "5000", 10),

  // ─── 重試 (筆電環境降低重試次數，避免放大延遲) ───
  RETRIES: parseInt(process.env.PROXY_RETRIES || "0", 10),

  // ─── 熔斷器 (Circuit Breaker) (筆電環境：敏感觸發、快速恢復) ───
  CB_THRESHOLD: parseInt(process.env.PROXY_CB_THRESHOLD || "3", 10),
  CB_RECOVERY_MS: parseInt(process.env.PROXY_CB_RECOVERY || "15000", 10),

  // ─── 速率限制 (筆電環境：降低上限，避免單機過載) ───
  RL_MAX: parseInt(process.env.PROXY_RATE_LIMIT || "300", 10),
  RL_WIN: parseInt(process.env.PROXY_RATE_WINDOW || "60000", 10),

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
  MODEL_CODER: process.env.PROXY_CODER_MODEL || "qwen3-coder-plus",

  // 模型預設值（envModels 偵測失敗時使用）
  MODEL_DEFAULTS: {
    small: "qwen3.6-27b",
    medium: "qwen3.6-plus",
    large: "qwen3-235b-a22b",
  },

  // ─── 負載路由降級 (筆電環境：更早降級、保護資源) ───
  // 降級後冷卻時間 (ms)，才允許升級
  MODEL_COOLDOWN: parseInt(process.env.PROXY_MODEL_COOLDOWN || "10000", 10),
  // 降級門檻（proxyInflight >= ? 時觸發，筆電環境門檻降低）
  DOWNGRADE_THRESHOLDS: {
    medium: 1, // ≥1 降一級（筆電單核處理能力有限）
    small: 2, // ≥2 強制 small
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

  // ─── 跨平台目錄 ───
  PATHS: {
    qwen2api: {
      linux:
        "/home/reamaster/opencode-manager/projects/independent/qwen2api-dev/qwen2api",
      darwin:
        "/Users/reamaster/opencode-manager/projects/independent/qwen2api-dev/qwen2api",
      win32:
        "D:\\Tools\\opencode\\opencode-manager\\projects\\independent\\qwen2api-dev\\qwen2api",
    },
    projectDir: {
      linux:
        "/home/reamaster/opencode-manager/projects/system/packages/opencode",
      darwin:
        "/Users/reamaster/opencode-manager/projects/system/packages/opencode",
      win32:
        "D:\\Tools\\opencode\\opencode-manager\\projects\\system\\packages\\opencode",
    },
  },
  // 環境變數對應鍵名（優先於 PATHS）
  PATH_ENV_MAP: {
    qwen2api: "QWEN2API_DIR",
    projectDir: "PROJECT_DIR",
  },
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
