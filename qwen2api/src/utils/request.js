const axios = require("axios");
const fs = require("fs");
const accountManager = require("./account.js");
const config = require("../config/index.js");
const { logger } = require("./logger");
const { getSsxmodItna, getSsxmodItna2 } = require("./ssxmod-manager");
const {
  getProxyAgent,
  getChatBaseUrl,
  applyProxyToAxiosConfig,
} = require("./proxy-helper");
const { generateUUID } = require("./tools.js");
const {
  getInstance: getChromeFetch,
  getCircuitBreakerState,
} = require("./chrome-fetch");
const curlFetch = require("./curl-fetch");
const {
  noteChatChallenge,
  chatBreakerState,
  assertChatChallengeBreakerClosed,
} = require("./upstream-error");

// ═══ Fix 2026-07-08 (v5): 連續 WAF 阻擋追蹤 + DashScope 自動降級 ═══
// 當連續 N 次請求都被 WAF 阻擋（HTTP 403/503），自動切換至 DashScope API（若已設定 key），
// 繞過 chat.qwen.ai WAF 的同時降低 Chrome 逾時，避免用戶等待過久。
let _consecWafBlocks = 0;
const CONSEC_WAF_DASHSCOPE_THRESHOLD = 3; // 連續 3 次 WAF 阻擋 → 切 DashScope
const CONSEC_WAF_TIMEOUT_REDUCE_THRESHOLD = 2; // 連續 2 次 → 降低 Chrome 逾時

// ═══ Fix 2026-07-20: DashScope 斷路器 ═══
// 當 DashScope 連續失敗（400/403/500），跳過直接走 Chrome/axios。
// 避免每次請求都浪費 DashScope 超時時間（120s）。
let _dashScopeDown = false;
let _dashScopeRetryAt = 0;
let _cbOpenLogged = false; // 斷路器開啟日誌節流：每個開啟週期僅輸出一次
let _dsFailCount = 0; // ═══ Fix 2026-07-20: DashScope 失敗計數器（需達閾值才斷路）═══
const DS_CB_FAIL_THRESHOLD = 3; // 連續 3 次失敗 → 斷路
const DS_CB_COOLDOWN_MS = 180000; // 3 分鐘後重試（一般錯誤，如 500/連線失敗）

// ═══ Fix 2026-07-09: DashScope 模型可用性快取（帶 TTL，避免永久封鎖） ═══
// workspace 只部署了 qwen-max 和 qwen-flash（無 qwen-plus），
// 每次請求 qwen-plus 都先拿 403 再降級，浪費一次 round-trip。
// 快取不可用的模型名 + 到期時間，後續請求直接跳過。
// ═══ Fix 2026-07-20: 區分 403（模型不可用）與 quota 耗盡（永久）═══
// 403 = 模型不在此 workspace → 5 分鐘 TTL（可能偶發）
// quota 耗盡 = 一次性 90 天額度用盡 → 1 年 TTL（不重置）
const _dsUnavailableModels = new Map(); // model -> 到期 timestamp
const DS_UNAVAIL_TTL_MS = 5 * 60 * 1000; // 403 模型不可用：5 分鐘後重試
const DS_QUOTA_EXHAUSTED_TTL_MS = 365 * 24 * 60 * 60 * 1000; // quota 耗盡：1 年（等進程重啟）
// ═══ 免額耗盡永久黑名單（進程生命週期內永不重試，連日誌都不打）═══
const _dsQuotaBlacklist = new Set();

// ═══ Fix: 黑名單持久化（進程重啟後立即恢復，第一輪請求也不打出去）═══
const _BLACKLIST_CACHE = require("path").join(
  require("os").tmpdir(),
  "qwen2api-quota-blacklist.json",
);
{
  try {
    if (fs.existsSync(_BLACKLIST_CACHE)) {
      const data = JSON.parse(fs.readFileSync(_BLACKLIST_CACHE, "utf-8"));
      if (Array.isArray(data.models)) {
        for (const m of data.models) _dsQuotaBlacklist.add(m);
        // 同步恢復斷路器狀態（全部免額耗盡 → 斷路）
        if (_dsQuotaBlacklist.size > 0) {
          _dashScopeDown = true;
          _dsFailCount = DS_CB_FAIL_THRESHOLD;
          _dashScopeRetryAt = Date.now() + DS_QUOTA_EXHAUSTED_TTL_MS;
        }
      }
    }
  } catch {}
}

const _saveBlacklist = () => {
  try {
    fs.writeFileSync(
      _BLACKLIST_CACHE,
      JSON.stringify({ models: [..._dsQuotaBlacklist] }),
    );
  } catch {}
};

const _isDsBlocked = (m) => {
  if (_dsQuotaBlacklist.has(m)) return true; // 永久跳過
  const exp = _dsUnavailableModels.get(m);
  if (!exp) return false;
  if (Date.now() >= exp) {
    _dsUnavailableModels.delete(m);
    return false;
  }
  return true;
};
const _blockDsModel = (m, ttlMs) => {
  _dsUnavailableModels.set(m, Date.now() + (ttlMs || DS_UNAVAIL_TTL_MS));
  // ═══ quota 耗盡 → 加入永久黑名單（進程內永不重試）═══
  if (ttlMs && ttlMs >= DS_QUOTA_EXHAUSTED_TTL_MS) _dsQuotaBlacklist.add(m);
};

// ═══ 2026-07-13: 免額耗盡直觀標示（節流）═══
// 首次一次報告，剩 ≤5 分（接近重置）才再廣播一次，避免輪詢刷屏。
const _quotaReported = new Map(); // model -> { firstAt, nearAt }
let _lastDsQuota = false; // 最近一次 DashScope 請求是否為免額耗盡（供 sendChatRequest 判斷）
// ═══ Fix 2026-07-20: 百煉免額為一次性 90 天有效期，耗盡不重置 ═══
// 直連千問官方 Web API（chat.qwen.ai）無每日限制，DashScope 僅做備援路線
let _dsQuotaResetAt = 0; // 免額耗盡的重置時間戳（百煉免額為一次性 90 天有效期，不每日重置）
const _parseQuotaReset = (txt) => {
  const now = Date.now();
  // 嘗試從錯誤訊息中解析重置時間（若有明確時間）
  const m = (txt || "").match(/(\d{1,2}):(\d{2})/);
  if (m) {
    try {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const d = new Date();
      d.setHours(h, min, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    } catch {}
  }
  // ═══ Fix 2026-07-20: 百煉免額為一次性 90 天有效期，耗盡不重置 ═══
  // 回傳「永不恢復」（+1 年），斷路器將持續關閉直到進程重啟
  return now + 365 * 24 * 60 * 60 * 1000;
};
const _logQuotaExhausted = (model, body) => {
  const now = Date.now();
  const _rep = _quotaReported.get(model) || {};
  if (!_rep.firstAt) {
    _quotaReported.set(model, { firstAt: now, nearAt: 0 });
    // ═══ Fix 2026-07-20: 免額耗盡不重置，warn 輸出無意義 → 靜默 ═══
    logger.debug(
      `[DashScope] ${model} 免額耗盡（一次性 90 天額度已用盡，靜默跳過）`,
      "REQUEST",
    );
  }
};

// 傳輸層（非 HTTP）錯誤碼 — 這些重試的, HTTP 回應不重試
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
]);

const isRetryableNetworkError = (error) => {
  if (!error) return false;
  // 已收到 HTTP 回應 = 上游回包了, 不是傳輸問題
  if (error.response) return false;
  if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
  if (
    typeof error.message === "string" &&
    error.message.includes("socket hang up")
  )
    return true;
  return false;
};

// ═══ Fix 2026-07-06 (v2): WAF 阻擋判斷 — HTTP 403/503 視為 WAF 可重試 ═══
const isWafBlock = (error) => {
  if (!error || !error.response) return false;
  const status = error.response.status;
  // WAF 常見狀態碼：403 (Forbidden)、503 (Service Unavailable)、429 (Rate Limit)
  return status === 403 || status === 503 || status === 429;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══ Fix 2026-07-06 (v2): Chat ID 快取 — 跨請求復用減少 WAF 觸發 ═══
// 同一個 model 在同一次對話中復用 chat_id，避免每個請求都建新 chat
const _chatIdCache = new Map(); // model → { chatId, expiresAt }
const _CHAT_ID_TTL = 30 * 60 * 1000; // 30 分鐘過期

/**
 * 取得或建立 chat_id（快取優先）
 * @param {string} token - JWT token
 * @param {string} model - 模型名稱
 * @param {object|null} account - 帳戶物件
 * @returns {Promise<string|null>}
 */
const getCachedChatId = async (token, model, account) => {
  const now = Date.now();
  const cached = _chatIdCache.get(model);
  if (cached && cached.chatId && now < cached.expiresAt) {
    return cached.chatId;
  }

  // 快取未命中或過期 → 建立新 chat
  const chatId = await _doCreateChatId(token, model, account);
  if (chatId) {
    _chatIdCache.set(model, { chatId, expiresAt: now + _CHAT_ID_TTL });
    // 限制快取大小（避免記憶體洩漏）
    if (_chatIdCache.size > 50) {
      const firstKey = _chatIdCache.keys().next().value;
      _chatIdCache.delete(firstKey);
    }
  }
  return chatId;
};

/**
 * 清除指定模型的 chat_id 快取（當請求返回無效 chat 時呼叫）
 * @param {string} model
 */
const invalidateChatId = (model) => {
  _chatIdCache.delete(model);
};

/**
 * 實際呼叫上游 API 建立新 chat（抽離自 generateChatID）
 */
const _doCreateChatId = async (token, model, account) => {
  try {
    const chatBaseUrl = getChatBaseUrl();
    const proxyAgent = getProxyAgent(account);
    const requestConfig = {
      timeout: 20000,
      headers: {
        "sec-ch-ua-platform": '"Windows"',
        authorization: `Bearer ${token}`,
        referer: `${chatBaseUrl}/`,
        "accept-language": "zh-CN,zh;q=0.9",
        "sec-ch-ua":
          '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "content-type": "application/json",
        "bx-v": "2.5.36",
        accept: "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        source: "web",
        version: "0.3.12",
        timezone: new Date().toString().replace(/GMT\+0800/, "GMT+0800"),
        "x-request-id": generateUUID(),
        connection: "keep-alive",
        cookie: `token=${token};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
        host: chatBaseUrl.replace("https://", ""),
        origin: chatBaseUrl,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    };
    if (proxyAgent) {
      requestConfig.httpsAgent = proxyAgent;
      requestConfig.proxy = false;
    }
    const response = await axios.post(
      `${chatBaseUrl}/api/v2/chats/new`,
      {
        title: "New Chat",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: new Date().getTime(),
      },
      requestConfig,
    );
    return response.data?.data?.id || null;
  } catch (error) {
    // WAF 阻擋時不記錄為 error（避免誤報）
    if (isWafBlock(error)) {
      logger.warn(
        `建立 chat_id 被 WAF 阻擋 (HTTP ${error.response?.status})，稍後重試`,
        "REQUEST",
      );
    } else {
      logger.error("建立 chat_id 失敗", "CHAT", "", error.message);
    }
    return null;
  }
};

/**
 * 發送聊天請求
 * @param {Object} body - 請求體
 * @returns {Promise<Object>} 回應結果
 */
// ═══ Fix 2026-07-08: WAF baxia 雙重校驗（TLS 指紋 + 動態 cookie） ═══
// 上游 WAF 現對 /api/v2/chats/new 與 /api/v2/chat/completions 同時校驗 TLS JA3
// 指紋與動態 cookie（cna/acw_tc/isg/ssxmod_itna...）。headless Chrome 內 fetch
// 遇到 WAF 黑洞會無限期掛起（page.evaluate 無法中斷），因此改為：
//   1) axios 優先（快速失敗，帶 Chrome 完整 cookie jar 提升成功率，不被掛起）
//   2) Chrome 僅作最後嘗試，且需設定硬性逾時避免請求卡死
// 這能避免「Chrome 掛起 20s+」造成的對話停滯體感。
const _isWafHtml = (text) =>
  typeof text === "string" &&
  text.includes("aliyun_waf") &&
  /<(!doctype|html|script)/i.test(text);

// ═══ Fix 2026-07-08: DashScope 官方 API 模式（繞過 chat.qwen.ai WAF） ═══
// 當設定 DASHSCOPE_API_KEY 時，改走百鍊 compatible-mode（OpenAI 相容），
// 直接 POST /v1/chat/completions，無需 chat_id / cookie 繞 WAF。
// 模型自動映射：qwen3.6-max* → qwen-max，qwen3.6-plus* → qwen-plus，
// 其餘 qwen3.6-* / 未知 → qwen-plus，輕量 → qwen-flash。
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_BASE =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

// ═══ Fix 2026-11-06: 上游模型白名單（依 /v1/models 實測）═══
// 可用   : qwen3.8-omni-flash / qwen3.7-plus / qwen3.6-plus / qwen3.5-plus / qwen3.5-omni-plus
// 已下架 : qwen3.8-flash / qwen3.8-max / qwen-max / qwen-flash
//          → 上游回 HTTP 200 但 content 為空（Completion: 0），不會觸發降級 → 使用者看到「卡住」。
// gateway 免額：僅 qwen3.8-omni-flash HTTP 200；其餘 plus 系列 403 insufficient_quota。
const _stripWebSuffix = (m) => {
  let s = String(m);
  let prev;
  do {
    prev = s;
    s = s.replace(/-(thinking|search|image-edit|image|video)$/, "");
  } while (s !== prev);
  return s;
};
const FREE_MODEL_FALLBACK = "qwen3.8-omni-flash";
const FREE_MODEL_ALIASES = {
  "qwen3.8-flash": FREE_MODEL_FALLBACK,
  "qwen3.8-max": FREE_MODEL_FALLBACK,
  "qwen3-max": FREE_MODEL_FALLBACK,
  "qwen-max": FREE_MODEL_FALLBACK,
  "qwen-flash": FREE_MODEL_FALLBACK,
  "qwen-turbo": FREE_MODEL_FALLBACK,
  "qwen-plus": "qwen3.6-plus",
  "qwen3.6-max": "qwen3.6-plus",
  "qwen3.7-max": "qwen3.7-plus",
  "qwen3.5-max": "qwen3.5-plus",
};
const _FREE_MODEL_RE =
  /^qwen3\.[5-8]-(plus|omni-plus|omni-flash)(-(thinking-search|thinking|search|image-edit|image|video))*$/;
const isValidFreeModel = (m) => _FREE_MODEL_RE.test(m);
const normalizeFreeModel = (model) => {
  if (!model) return FREE_MODEL_FALLBACK;
  const raw = String(model).toLowerCase();
  if (FREE_MODEL_ALIASES[raw]) return FREE_MODEL_ALIASES[raw];
  if (isValidFreeModel(raw)) return raw;
  const base = _stripWebSuffix(raw);
  if (FREE_MODEL_ALIASES[base]) return FREE_MODEL_ALIASES[base];
  if (isValidFreeModel(base)) return base;
  return FREE_MODEL_FALLBACK;
};
const mapToDashscopeModel = (model) => {
  const m = _stripWebSuffix(String(model || "").toLowerCase());
  if (m === "qwen3.8-omni-flash" || m === "qwen3.5-omni-plus")
    return m;
  // 已下架/額度耗盡的 max、flash、qwen3.8-flash 一律映射到實測可用的模型
  if (m.includes("plus")) return "qwen3.6-plus";
  return FREE_MODEL_FALLBACK;
};

const sendDashscopeRequest = async (body) => {
  const url = `${DASHSCOPE_BASE}/chat/completions`;

  // ═══ Fix 2026-11-06: 梯隊只放實測可用模型（依 /v1/models）═══
  // 舊梯隊含 qwen-max / qwen3.8-flash / qwen-flash，已下架或配額耗盡，
  // 徒增 403 round-trip。gateway 目前僅 qwen3.8-omni-flash 免額可用。
  const MODEL_TIERS = ["qwen3.8-omni-flash", "qwen3.6-plus"];
  _lastDsQuota = false; // 每次請求重置，避免上一輪 quota 狀態污染本輪斷路判斷
  const targetTier = mapToDashscopeModel(body.model);
  const tryModels = [targetTier, ...MODEL_TIERS.filter((m) => m !== targetTier)];

  const _safeErrorBody = (err) => {
    try {
      if (err?.response?.data == null) return "";
      const d = err.response.data;
      if (typeof d === "string") return d.slice(0, 300);
      if (Buffer.isBuffer(d)) return d.toString("utf-8").slice(0, 300);
      if (typeof d === "object" && d.constructor === Object)
        return JSON.stringify(d).slice(0, 300);
      return String(d).slice(0, 200);
    } catch {
      return "(無法讀取回應體)";
    }
  };

  const requestConfig = {
    headers: {
      Authorization: `Bearer ${DASHSCOPE_KEY}`,
      "Content-Type": "application/json",
    },
    responseType: "stream",
    timeout: 120 * 1000,
  };
  if (config.proxyUrl) {
    const agent = getProxyAgent({ proxy: config.proxyUrl });
    if (agent) {
      requestConfig.httpsAgent = agent;
      requestConfig.proxy = false;
    }
  }

  for (let ti = 0; ti < tryModels.length; ti++) {
    const dsModel = tryModels[ti];
    // ═══ Fix 2026-07-09: 跳過已知不可用的模型（帶 TTL 自動恢復） ═══
    if (_isDsBlocked(dsModel)) {
      // ═══ 免額耗盡（TTL > 1hr）靜默跳過；一般 403（5min）才顯示 ═══
      const _exp = _dsUnavailableModels.get(dsModel);
      const _isQuotaBlock = _exp && _exp - Date.now() > 60 * 60 * 1000;
      if (!_isQuotaBlock) {
        logger.network(
          `[DashScope] 跳過已知不可用模型 ${dsModel}（5min 內恢復重試）`,
          "REQUEST",
        );
      }
      continue;
    }
    // ═══ Fix 2026-07-12: DashScope 400 修復 ═══
    // 1. 過濾不相容的角色（DashScope compatible mode 僅支援 system/user/assistant/tool）
    // 2. enable_thinking 僅對 max/plus 模型送出（flash 不支援 thinking）
    // 3. 工具參數僅首個模型嘗試（降級模型不送 tools）
    const _dsRoles = new Set(["system", "user", "assistant", "tool"]);
    const _dsMsgs = (body.messages || []).filter(
      (m) =>
        _dsRoles.has(m.role) &&
        typeof m.content === "string" &&
        m.content.length > 0,
    );
    // 避免空訊息數組導致 400
    if (_dsMsgs.length === 0) {
      logger.warn(
        `[DashScope] 過濾後無有效訊息 (model=${dsModel})，跳過`,
        "REQUEST",
      );
      continue;
    }
    const payload = {
      model: dsModel,
      messages: _dsMsgs,
      stream: true,
    };
    // ═══ Fix 2026-07-12: enable_thinking 僅 max/plus 支援 ═══
    // flash 模型不支援 thinking，送出會 400。僅 plus 系列才送。
    const _supportsThinking =
      typeof body.enable_thinking === "boolean" && dsModel.includes("plus");
    if (_supportsThinking) {
      payload.enable_thinking = body.enable_thinking;
    }
    // 工具參數僅首個模型嘗試（降級模型不送 tools，避免 400）
    if (body.tools && ti === 0) payload.tools = body.tools;
    if (body.tool_choice && ti === 0) payload.tool_choice = body.tool_choice;

    try {
      // ═══ 僅正常模型才顯示；免額耗盡模型在 tryModels 迭代前已過濾 ═══
      logger.network(`發送聊天請求 (DashScope ${dsModel})`, "REQUEST");
      const response = await axios.post(url, payload, requestConfig);
      if (response.status === 200) {
        // 模型降級日誌（幫助調試）
        if (ti > 0) {
          logger.warn(
            `[DashScope] 使用降級模型 ${dsModel}（原始: ${tryModels[0]}）`,
            "REQUEST",
          );
        }
        return {
          currentToken: DASHSCOPE_KEY,
          currentAccount: { email: "dashscope", token: DASHSCOPE_KEY },
          status: true,
          response: response.data,
          isDashscope: true,
        };
      }
      logger.error(
        `DashScope 回應異常 HTTP ${response.status} (model=${dsModel})`,
        "REQUEST",
        "",
        new Error(`status ${response.status}`),
      );
      break; // 非 200 的回應（非 400）不值得繼續降級
    } catch (error) {
      const status = error.response?.status;
      if (status === 429) {
        logger.warn(
          `DashScope 限流 (429) (model=${dsModel})，免費額度 QPM 較低`,
          "REQUEST",
        );
        return { status: false, response: null }; // 限流不降級，等冷卻
      }
      // 400/403 = 模型在此 workspace 不可用或額度耗盡
      if (status === 400 || status === 403) {
        // ═══ 2026-07-13: 免額耗盡直觀標示（首次一次，接近重置再廣播）═══
        // 注意：requestConfig 設 responseType:"stream"，error.response.data 為
        // stream 物件無法讀取 JSON body，故 403 直接視為免額耗盡標示
        // （DashScope 免費模型 403 = 額度/權限問題）；400 才依 body 關鍵字判斷。
        const _body = error.response?.data
          ? JSON.stringify(error.response.data)
          : "";
        const _isQuota =
          status === 403 ||
          /quota|limit|額度|限額|exceeded|免額|free/i.test(_body);
        // ═══ Fix 2026-07-20: quota 耗盡用長 TTL（不重置），一般 403 用短 TTL ═══
        _blockDsModel(
          dsModel,
          _isQuota ? DS_QUOTA_EXHAUSTED_TTL_MS : undefined,
        );
        if (_isQuota) {
          // 免額耗盡：已判斷改用其他路線，抑制降級噪音，僅保留 🔶 標示
          _lastDsQuota = true;
          _dsQuotaResetAt = _parseQuotaReset(_body);
          _logQuotaExhausted(dsModel, _body);
          if (ti < tryModels.length - 1) {
            // ═══ 免額耗盡不重置，跳過提示靜默 ═══
            continue;
          }
          break;
        }
        if (ti < tryModels.length - 1) {
          logger.warn(
            `[DashScope] ${dsModel} 不可用 (${status})，降級至 ${tryModels[ti + 1]}${ti > 0 ? `（已封鎖 ${_dsUnavailableModels.size} 個已知不可用模型）` : ""}`,
            "REQUEST",
          );
          continue;
        }
        // 最後模型仍 400/403 → 結束降級
        logger.warn(
          `[DashScope] ${dsModel} 不可用 (${status})，已無可降級模型`,
          "REQUEST",
        );
        break;
      }
      // 其他錯誤（500/連線失敗）直接回報
      const _safe = _safeErrorBody(error);
      logger.error(
        `DashScope 請求失敗 (${status})${_safe ? ` body=${_safe}` : ""} (model=${dsModel})`,
        "REQUEST",
      );
      break;
    }
  }

  return { status: false, response: null, quota: _lastDsQuota };
};

/**
 * 讀取 SSE 串流首幀，判定是否為 Qwen chat challenge
 *
 * Qwen 在尖峰時段以 HTTP 200 回 {ret:['FAIL_SYS_USER_VALIDATE', ...被挤爆啦]}，
 * 該幀沒有 choices/content，若不攔截會被當成「200 但空內容」→ client 收到空回覆。
 *
 * ⚠️ 關鍵：Axios 的 stream 一旦有 data listener 消費，就無法 unshift 回頭。
 *    因此這裡改用「tee + 重建 stream」策略：把讀到的首幀交給呼叫端
 *    一併處理，呼叫端必須把 peeked 內容寫進最終輸出。
 *    回傳 { challenge, stream, peeked } 而不是單純 boolean。
 *
 * @param {stream.Readable} s - Axios SSE 串流
 * @returns {Promise<{challenge: boolean, stream: Readable, peeked: string}>}
 */
const _peekChallengeInStream = async (s) => {
  const { PassThrough } = require("stream");
  const CH_RE =
    /fail_sys_user_validate|rgv587|被挤爆|_____tmd_____|action=captcha/i;
  const CONTENT_RE =
    /"(content|reasoning_content|tool_calls)"\s*:\s*(?:"[^"]+"|\[|\{)/;

  if (!s || typeof s.on !== "function") {
    return { challenge: false, empty: false, stream: s, peeked: "" };
  }

  const head = new PassThrough();
  let buf = "";
  let ended = false;

  await new Promise((resolve) => {
    let settled = false;
    let tid;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      s.removeListener("data", onData);
      s.removeListener("end", onEnd);
      if (reason === "end") {
        ended = true;
        // 首幀內容轉發到重建的串流，確保上層讀得到
        if (buf) head.write(buf);
        head.end();
      } else {
        if (buf) head.write(buf);
        s.pipe(head, { end: true });
      }
      resolve();
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      if (CH_RE.test(buf) && /\n\n/.test(buf)) return finish("data");
      if (/\n\n/.test(buf) && CONTENT_RE.test(buf)) return finish("data");
      if (
        /\n\n/.test(buf) &&
        /"finish_reason"\s*:\s*"stop"/.test(buf)
      )
        return finish("data");
      if (buf.length > 4096) return finish("data");
    };
    const onEnd = () => finish("end");
    s.on("data", onData);
    s.on("end", onEnd);
    tid = setTimeout(() => finish("timeout"), 2500);
  });

  const challenge = CH_RE.test(buf);
  const hasContent = CONTENT_RE.test(buf);
  // 只有「串流已結束且完全沒有任何內容」才判為空回覆；
  // 逾時但串流仍在跑（模型思考中）不判空，避免誤殺正常請求。
  const empty = ended && !challenge && !hasContent;
  return { challenge, empty, stream: head, peeked: buf };
};

const sendChatRequest = async (body) => {
  // ═══ Fix 2026-10-18 (v6): 免額優先，DashScope 降為最後備援 ═══
  //
  // 【原缺陷】sendChatRequest 開頭直接 `if (DASHSCOPE_KEY) { 試 DashScope }`，
  //           失敗才落到免額（chat.qwen.ai）。實際結果：
  //           1. 每次請求先燒一次百煉配額（= 付費），即使免額完全正常
  //           2. 百煉免額耗盡（insufficient_quota）時，額度在第一跳就被吃掉，
  //              免額路徑根本沒被嘗試 → 「多餘花費」+ 免額形同虛設
  //
  // 【修正原則】免額是主路線，百煉只在以下條件同時成立時才啟用：
  //   - 明確設定 DASHSCOPE_ALLOW_FALLBACK=true（預設關閉 = 明確不花錢）
  //   - 免額路徑本輪已失敗（chat challenge / WAF / 無可用帳戶）
  //   - DashScope 未被斷路器關閉
  //
  // 這讓「支持免額使用」成為預設行為，而非需要使用者主動關掉的開關。
  const allowDashScopeFallback =
    process.env.DASHSCOPE_ALLOW_FALLBACK === "true";
  const freeAttempt = await sendFreeRequest(body);
  if (freeAttempt?.status && freeAttempt?.response) {
    // 免額成功 → 完全不碰百煉
    return freeAttempt;
  }

  // 免額失敗：僅在使用者明確允許時才降級到百煉
  if (!allowDashScopeFallback) {
    if (!DASHSCOPE_KEY) return freeAttempt;
    logger.info(
      "[免額優先] 免額路徑失敗且 DASHSCOPE_ALLOW_FALLBACK 未開啟 → 不使用百煉（避免付費）",
      "REQUEST",
    );
    return freeAttempt;
  }

  if (DASHSCOPE_KEY) {
    const now = Date.now();
    if (!_dashScopeDown || now >= _dashScopeRetryAt) {
      const dsResult = await sendDashscopeRequest(body);
      if (dsResult.status && dsResult.response) {
        // 成功→重置斷路器
        _dashScopeDown = false;
        _dashScopeRetryAt = 0;
        _dsFailCount = 0;
        _cbOpenLogged = false;
        return dsResult;
      }
      // ═══ Fix 2026-07-20: 免額耗盡立即斷路，其他錯誤需達閾值 ═══
      if (dsResult.quota) {
        // 免額耗盡：立即斷路（恢復需等每日重置）
        _dashScopeDown = true;
        _dsFailCount = DS_CB_FAIL_THRESHOLD;
        // ═══ Fix 2026-07-20: 百煉免額為一次性 90 天有效期，耗盡不重置 ═══
        // 額度用盡後僅在進程重啟時才重新嘗試 DashScope
        _dashScopeRetryAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
        _cbOpenLogged = false;
        // ═══ 免額耗盡不重置，info 輸出無意義 → 靜默 ═══
      } else {
        // 其他錯誤：遞增計數，達閾值才斷路
        _dsFailCount++;
        if (_dsFailCount >= DS_CB_FAIL_THRESHOLD) {
          _dashScopeDown = true;
          _dashScopeRetryAt = Date.now() + DS_CB_COOLDOWN_MS;
          logger.warn(
            `[DashScope] 連續 ${_dsFailCount} 次失敗，斷路器開啟 → 改用 Chrome/axios`,
            "REQUEST",
          );
        } else {
          logger.warn(
            `[DashScope] 失敗 (${_dsFailCount}/${DS_CB_FAIL_THRESHOLD})，暫不降級`,
            "REQUEST",
          );
        }
        _cbOpenLogged = false;
      }
    } else {
      // 節流：每個開啟週期僅輸出一次，避免每輪請求重複刷屏
      if (!_cbOpenLogged) {
        _cbOpenLogged = true;
        logger.warn(
          `[DashScope] 斷路器開啟中，跳過直達 Chrome/axios (冷卻至 ${new Date(_dashScopeRetryAt).toLocaleTimeString()})`,
          "REQUEST",
        );
      }
    }
  }

  // ═══ Fix 2026-10-18 (v6): 免額主路線實作 ═══
  // 原本這段直接內嵌在 sendChatRequest 尾端（DashScope 之後）。
  // 抽出成獨立函式，讓「免額優先」在流程上是第一跳，而非降級目標。
  return await sendFreeRequest(body);
};

/**
 * 免額路線（chat.qwen.ai）主流程
 * 依序嘗試：curl-impersonate → Chrome Fetch → axios
 * @param {Object} body - 請求體
 * @returns {Promise<Object>} { status, response }
 */
const sendFreeRequest = async (body) => {
  // ═══ Fix 2026-11-06: 送出前正規化模型名 ═══
  // 上游對已下架名稱回 HTTP 200 + 空 content，不會報錯也不會觸發降級，
  // 使用者只看到空回覆／卡住。這裡先映射到實測可用的模型。
  const _freeModel = normalizeFreeModel(body.model);
  if (_freeModel !== body.model) {
    logger.warn(
      `[MODEL] ${body.model} 不在上游模型清單，改用 ${_freeModel}`,
      "MODEL",
    );
    body = { ...body, model: _freeModel };
  }
  // ═══ Fix 2026-10-18: chat challenge 熔斷中 → 直接回 503，不打 Qwen ═══
  // 連續 3 次 challenge 後開啟 60 秒熔斷。熔斷期間若仍發請求，
  // 等於持續在被風控的 IP 上 hammer Qwen，只會讓封鎖更久。
  try {
    assertChatChallengeBreakerClosed();
  } catch (e) {
    logger.warn(
      `[WAF] 熔斷開啟中（剩 ${e.retryAfter}s），跳過免額請求`,
      "REQUEST",
    );
    return { status: false, response: null, error: "waf_breaker_open" };
  }

  // 取得可用的帳戶（包含 proxy 等完整字段）
  const currentAccount = accountManager.getAccount();
  // Fix 2026-10-05: browser 模式的 access token 效期僅約 15 分鐘，
  // 送出前必須確保新鮮（過期時用 refresh_token cookie 換取新 token）
  let currentToken = currentAccount ? currentAccount.token : null;
  if (currentAccount && accountManager.tokenManager?.ensureFreshToken) {
    currentToken =
      await accountManager.tokenManager.ensureFreshToken(currentAccount);
  }

  if (!currentToken) {
    logger.error("無法取得有效的通路令牌", "TOKEN");
    return { status: false, response: null };
  }

  // ═══ Fix 2026-07-08: 先建立 chat_id（axios 可靠），供 Chrome 與 axios 共用 ═══
  // 原本 Chrome 內 createChat page.evaluate 因 SPA 載入阻塞而一致逾時 (20s)，
  // 導致 Chrome 路徑從未被使用，每次都降級至 axios。改為 axios 建立 chat_id
  // 後傳入 Chrome，Chrome 只負責 SSE 串流（需 WAF 繞過的熱點）。
  const chat_id = await getCachedChatId(
    currentToken,
    body.model,
    currentAccount,
  );
  if (!chat_id) {
    logger.error("產生chat_id失敗，無法發送請求", "REQUEST");
    return { status: false, response: null, error: "chat_id_failed" };
  }
  // ═══ Fix 2026-07-12: enable_thinking 僅百煉支援，免額路線必須移除 ═══
  // Chrome Fetch / curl-impersonate / axios 走 Qwen Web API（chat.qwen.ai），
  // 不支援百煉的 enable_thinking 參數，送出該參數會導致 Web API 回空內容。
  // 2026-10-18 註：免額已升為主路線，此處為必要處理（非僅在降級時）。
  const { enable_thinking: _et, ...restBody } = body;
  const bodyWithChatId = { ...restBody, stream: true, chat_id };

  // ═══ Fix 2026-07-08 (v6): 首次 WAF 阻擋即縮短 Chrome 逾時 ═══
  // 問題：WAF 阻擋期間 Chrome 每次花 15s timeout 才降級 axios，首次阻擋就浪費 15s+8s。
  // 解法：連續 WAF 阻擋 ≥1 次即進入 WAF 模式（閾值 2→1），Chrome timeout 縮至 8s；
  // 正常基準也從 15s 降至 10s，加速首次失敗感知。
  const _cbState = getCircuitBreakerState();
  const _inWafMode = _cbState.wafMode || _consecWafBlocks >= 1;
  // ═══ Fix 2026-10-19: 自適應 Chrome 逾時 ═══
  // 頁面已預熱（ready=true）時用 15s（頁面建立已完成，不需要 30s 等待）；
  // 未預熱時維持 30s（頁面建立需 17s+）。
  // 根因：首筆請求在 WAF 模式觸發前浪費完整 30s 等待 Chrome timeout。
  // 修復：預熱後縮短至 15s，加速首次失敗感知，減少「上游無回應」等待時間。
  const _chromeReady = (() => {
    try {
      const cf = getChromeFetch();
      return !!(cf && cf.ready);
    } catch {
      return false;
    }
  })();
  const CHROME_TIMEOUT_MS = _inWafMode ? 8000 : _chromeReady ? 15000 : 30000; // WAF 模式 8s，預熱後 15s，未預熱 30s（頁面建立需 17s+）

  // ═══ 2026-07-08 (v9): DashScope 僅被動使用（不自動繞過 WAF） ═══
  // DashScope 僅透過 PROVIDER_NAMES 設定的 Provider Router 被動調用，
  // 不做為 WAF 阻擋時的主動降級路徑，避免意外繞過上游限制。

  // ====== 主路徑: Chrome Fetch（chat_id 已備妥，僅處理 SSE 串流） ======
  // 加動態逾時，避免 WAF 黑洞導致 Chrome SSE 無限期掛起、對話停滯。
  // ═══ Fix 2026-07-08: 30s→15s 加速降級，大部分逾時在 10-12s 內發生 ═══
  // ═══ Fix 2026-07-08 (v2): AbortController 逾時通知 Chrome 清理，避免孤立 stream ═══
  // ═══ Fix 2026-07-08 (v5): WAF 模式時縮短至 8s，加速降級 ═══
  // ═══ Fix 2026-07-08 (v7): WAF 模式跳過 Chrome 主路徑，直接 axios ═══
  // ═══ Fix 2026-07-20: 正常模式 10s→30s（頁面建立需 17s，10s 永遠不夠）═══
  // 證據：Chrome SSE page.evaluate 在 WAF 阻擋時一致逾時（20s+），
  // 每請求浪費 8-10s 等待 Chrome timeout 才降級 axios。
  // WAF 模式時 Chrome 幾乎必敗，直接跳過省下這些時間。
  if (
    !_inWafMode &&
    process.env.DISABLE_BROWSER !== "true" &&
    process.env.CHROME_DISABLED !== "true"
  ) {
    const chromeAbort = new AbortController();
    const chromeReq = (async () => {
      const chromeFetch = getChromeFetch();
      if (!chromeFetch) return null;
      return chromeFetch.sendChatRequest(
        bodyWithChatId,
        currentAccount,
        chromeAbort.signal,
      );
    })();
    const timeout = new Promise((resolve) => {
      const tid = setTimeout(() => {
        chromeAbort.abort(
          new Error(`Chrome request timed out (${CHROME_TIMEOUT_MS / 1000}s)`),
        );
        resolve(null);
      }, CHROME_TIMEOUT_MS);
      // 若 chromeReq 提前完成，清除 timeout
      chromeReq.finally(() => clearTimeout(tid));
    });
    const chromeResult = await Promise.race([chromeReq, timeout]);
    if (chromeResult && chromeResult.status && chromeResult.response) {
      logger.network(`[Chrome Fetch] 請求成功`, "REQUEST");
      return chromeResult;
    }
    if (chromeResult === null) {
      logger.warn(
        `[Chrome Fetch] 逾時 (${CHROME_TIMEOUT_MS / 1000}s)，降級 axios`,
        "REQUEST",
      );
    }
  }

  // ====== 中間路徑: curl-impersonate（無需 Chrome，輕量繞 WAF） ======
  if (curlFetch.findCurl() && curlFetch._cbCanTry()) {
    const wafCookies = await curlFetch._getWafCookies();
    if (wafCookies !== null) {
      const curlStream = new (require("stream").PassThrough)();
      curlStream.on("error", () => {});
      const _curlBaseUrl = getChatBaseUrl();
      // ═══ Fix 2026-07-12: 補齊完整 headers ═══
      // 原本只有 Authorization/source/version，缺少 cookie/host/origin/referer 等，
      // 導致 API 回傳 HTTP 200 但 body 為空（Completion: 0）。
      // 複製 axios 路徑的完整 headers，確保 API 識別請求來源。
      // 合併 auth cookies + WAF cookies 為單一 cookie header
      const _authCookie = `token=${currentToken};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`;
      const _mergedCookie = wafCookies
        ? `${_authCookie};${wafCookies}`
        : _authCookie;
      const curlHeaders = {
        "sec-ch-ua-platform": '"Windows"',
        authorization: `Bearer ${currentToken}`,
        referer: `${_curlBaseUrl}/`,
        "accept-language": "zh-CN,zh;q=0.9",
        "sec-ch-ua":
          '"Chromium";v="116", "Not)A;Brand";v="8", "Google Chrome";v="116"',
        "sec-ch-ua-mobile": "?0",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
        "content-type": "application/json",
        "bx-v": "2.5.36",
        accept: "text/event-stream",
        "accept-encoding": "gzip, deflate, br, zstd",
        source: "web",
        version: "0.3.12",
        timezone: new Date().toString().replace(/GMT\+0800/, "GMT+0800"),
        "x-request-id": generateUUID(),
        connection: "keep-alive",
        cookie: _mergedCookie,
        origin: _curlBaseUrl,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-accel-buffering": "no",
      };
      const curlUrl = `${_curlBaseUrl}/api/v2/chat/completions?chat_id=${chat_id}`;
      const curlOk = await curlFetch.curlSse({
        url: curlUrl,
        headers: curlHeaders,
        body: JSON.stringify(bodyWithChatId),
        wafCookies,
        stream: curlStream,
      });
      if (curlOk) {
        // ═══ 檢查 stream 是否有有效資料 ═══
        // WAF 隱形阻擋：回傳 SSE 格式但無 delta.content（Completion: 0）
        // ═══ Fix 2026-10-18: 同時判定 chat challenge ═══
        //
        // 【原缺陷】curlSse 已把資料寫入 PassThrough，但監聽器在 curlOk 之後才掛，
        //           首幀常在掛載前已流入緩衝 → 5 秒窗口內讀不到任何內容 →
        //           一律判為「無有效內容」而降級，challenge 被反覆重試。
        //
        // ═══ Fix 2026-10-21: 檢查期絕對不可消費下游 stream ═══
        // 【原缺陷 2】檢查用 curlStream.on("data") 讀取 PassThrough
        //           → PassThrough 立即進入 flowing mode → 資料被檢查期吃掉
        //           → controller 再掛 listener 時首幀已遺失
        //           症狀：回應永遠少第一個字（「快取」→「取」、「數到20」→「, 2,」）。
        // 【修正】改用 curlFetch.peekBuffered() 讀取 curl-fetch 端自行累積的
        //           原始 SSE 副本，完全不觸碰下游 stream。
        const _CHALLENGE_RE =
          /fail_sys_user_validate|rgv587|被挤爆|_____tmd_____|action=captcha/i;
        const hasData = await new Promise((resolve) => {
          const tid = setInterval(() => {
            const buf = curlFetch.peekBuffered(curlStream) || "";
            if (_CHALLENGE_RE.test(buf)) {
              clearInterval(tid);
              resolve("challenge");
              return;
            }
            if (/"content"\s*:\s*"[^"]+"/.test(buf)) {
              clearInterval(tid);
              resolve("ok");
              return;
            }
          }, 200);
          // 上限 5 秒；避免無回應時無限等待
          setTimeout(() => {
            clearInterval(tid);
            const buf = curlFetch.peekBuffered(curlStream) || "";
            if (_CHALLENGE_RE.test(buf)) {
              resolve("challenge");
              return;
            }
            resolve(/"content"\s*:\s*"[^"]+"/.test(buf) ? "ok" : false);
          }, 5000);
        });
        if (hasData === "challenge") {
          // ═══ chat challenge → 明確回報，不降級、不重試 ═══
          noteChatChallenge();
          logger.warn(
            `[WAF] curl 路徑收到 chat challenge（strikes=${chatBreakerState().strikes}）→ 回 503，不再降級重試`,
            "REQUEST",
          );
          return { status: false, response: null, error: "waf_challenge" };
        }
        if (hasData) {
          curlFetch._cbSuccess();
          _consecWafBlocks = 0;
          logger.network(`[curl-impersonate] 請求成功`, "REQUEST");
          return { status: true, response: curlStream, currentAccount };
        }
        // ═══ Fix 2026-07-14: curl 200 但無有效內容 → 視為 WAF 隱形阻擋 ═══
        // （chat challenge 已在上面的 hasData 檢查分流，不會走到這裡）
        curlFetch._cbFail();
        _consecWafBlocks++;
        invalidateChatId(body.model);
        logger.warn(
          `[curl-impersonate] SSE 無有效內容（疑似 WAF 隱形阻擋，連續 ${_consecWafBlocks} 次），降級`,
          "REQUEST",
        );
      } else {
        curlFetch._cbFail();
        logger.warn("[curl-impersonate] 請求失敗，降級", "REQUEST");
      }
    }
  }

  // ====== 降級路徑: axios（帶 Chrome 完整 cookie jar，快失敗不掛起） ======
  const chatBaseUrl = getChatBaseUrl();
  const proxyAgent = getProxyAgent(currentAccount);

  let cookieJar = `token=${currentToken};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`;
  try {
    const chromeFetch = getChromeFetch();
    if (chromeFetch && chromeFetch.page && chromeFetch.ready) {
      const ck = await chromeFetch.page.cookies();
      if (ck && ck.length) {
        cookieJar = ck.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    }
  } catch (_) {
    /* cookie 讀取失敗則維持預設 jar */
  }

  const requestConfig = {
    headers: {
      "sec-ch-ua-platform": '"Windows"',
      authorization: `Bearer ${currentToken}`,
      referer: `${chatBaseUrl}/`,
      "accept-language": "zh-CN,zh;q=0.9",
      "sec-ch-ua":
        '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "content-type": "application/json",
      "bx-v": "2.5.36",
      accept: "text/event-stream",
      "accept-encoding": "gzip, deflate, br, zstd",
      source: "web",
      version: "0.3.12",
      timezone: new Date().toString().replace(/GMT\+0800/, "GMT+0800"),
      "x-request-id": generateUUID(),
      connection: "keep-alive",
      cookie: cookieJar,
      host: chatBaseUrl.replace("https://", ""),
      origin: chatBaseUrl,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-accel-buffering": "no",
    },
    responseType: "stream",
    timeout: 60 * 1000,
  };

  if (proxyAgent) {
    requestConfig.httpsAgent = proxyAgent;
    requestConfig.proxy = false;
  }

  // chat_id 已由上方 getCachedChatId 建立（Chrome/axios 共用），直接複用
  const url = `${chatBaseUrl}/api/v2/chat/completions?chat_id=` + chat_id;

  const maxRetries = Math.max(0, parseInt(config.chatRetryCount, 10) || 0);
  const backoffMs = Math.max(0, parseInt(config.chatRetryBackoffMs, 10) || 0);
  const totalAttempts = maxRetries + 1;

  let lastError = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      if (attempt === 1) logger.network(`發送聊天請求 (axios)`, "REQUEST");
      const response = await axios.post(url, bodyWithChatId, requestConfig);
      if (response.status === 200) {
        // ═══ Fix 2026-10-18: axios 也可能收到 challenge 幀 ═══
        // curl 路徑的 5 秒內容檢查可能因為資料延遲而漏判，
        // 這裡在串流轉發前再檢一次，確保 challenge 不被當成 200 成功。
        const peek = await _peekChallengeInStream(response.data);
        if (peek.challenge) {
          noteChatChallenge();
          logger.warn(
            `[WAF] axios 路徑收到 chat challenge（strikes=${chatBreakerState().strikes}）→ 回 503`,
            "REQUEST",
          );
          return { status: false, response: null, error: "waf_challenge" };
        }
        // ═══ Fix 2026-11-06: 200 但串流立即結束且無任何內容 → 視為失敗 ═══
        // 上游對已下架模型回 200 + 空串流，若當成成功會讓 client 收到空回覆
        // （Completion: 0）且不會降級，使用者經驗就是「卡住」。
        if (peek.empty) {
          logger.warn(
            `[axios] 200 但無有效內容（model=${body.model}），視為失敗並降級`,
            "REQUEST",
          );
          invalidateChatId(body.model);
          lastError = new Error("empty_stream");
          if (attempt < totalAttempts) {
            if (backoffMs > 0) await delay(backoffMs);
            continue;
          }
          break;
        }
        // ═══ Fix 2026-07-08 (v5): axios 成功 → 重設連續 WAF 計數 ═══
        _consecWafBlocks = 0;
        return {
          currentToken,
          currentAccount,
          status: true,
          response: peek.stream,
        };
      }
      lastError = new Error(`Unexpected status ${response.status}`);
      lastError.response = { status: response.status };
      break;
    } catch (error) {
      lastError = error;
      // ═══ Fix v3: WAF 阻擋時清除快取，下次重試用新 chat_id ═══
      if (isWafBlock(error)) {
        // ═══ Fix 2026-07-08 (v5): 追蹤連續 WAF 阻擋 ═══
        _consecWafBlocks++;
        logger.warn(
          `🧹 WAF 阻擋 (HTTP ${error.response?.status})，清除 chat_id 快取後重試（連續 ${_consecWafBlocks} 次 WAF）`,
          "REQUEST",
        );
        // WAF 阻擋後清空快取，下次重試用新 chat_id
        invalidateChatId(body.model);
        // ═══ Fix 2026-07-07: WAF 觸發時嘗試恢復 Chrome Fetch ═══
        // Axios WAF 阻擋表示 cookie 不夠力，嘗試重新啟用 Chrome Fetch
        // ═══ Fix 2026-07-20: Chrome 未安裝時禁止恢復（避免無限循環） ═══
        if (
          process.env.CHROME_DISABLED === "true" &&
          process.env.CHROME_NOT_FOUND !== "true"
        ) {
          logger.info("🔄 WAF 阻擋觸發 Chrome Fetch 自動恢復...", "REQUEST");
          process.env.CHROME_DISABLED = "false";
          process.env.DISABLE_BROWSER = "false";
        }
      } else {
        // ═══ Fix 2026-07-08 (v5): 非 WAF 錯誤時重設連續 WAF 計數 ═══
        // 若成功收到回應（即使非 200），表示 WAF 已放行，重設計數
        if (error.response) {
          _consecWafBlocks = 0;
        }
      }
      if (isRetryableNetworkError(error) && attempt < totalAttempts) {
        logger.warn(
          `聊天請求傳輸錯誤 (嘗試 ${attempt}/${totalAttempts}, code=${error.code || "unknown"}): ${error.message}`,
          "REQUEST",
        );
        if (backoffMs > 0) await delay(backoffMs);
        continue;
      }
      break;
    }
  }

  if (lastError && currentAccount?.email) {
    const hadHttpResponse = !!lastError.response;
    if (!hadHttpResponse && isRetryableNetworkError(lastError)) {
      logger.error(
        `聊天請求傳輸失敗 (已嘗試 ${totalAttempts} 次): ${lastError.message}`,
        "REQUEST",
      );
      logger.info(
        `帳戶 ${currentAccount.email} 標記失敗 (傳輸錯誤, 累計接近 cooldown)`,
        "ACCOUNT",
      );
      accountManager.recordAccountFailure(currentAccount.email, lastError.code);
    } else {
      const status = lastError.response?.status;
      logger.error("發送聊天請求失敗", "REQUEST", "", lastError.message);
      accountManager.recordAccountError(currentAccount.email, status);
      // ═══ Fix v3: WAF 阻擋時清除聊天 ID 快取，下次使用新 chat ═══
      if (isWafBlock(lastError)) {
        invalidateChatId(body.model);
        logger.warn(
          `🧹 WAF 阻擋 (HTTP ${status})，清除 ${body.model} 的 chat_id 快取`,
          "REQUEST",
        );
      }
    }
  } else if (lastError) {
    logger.error("發送聊天請求失敗", "REQUEST", "", lastError.message);
    // ═══ Fix v3: 無帳號情境也清除快取 ═══
    if (isWafBlock(lastError)) {
      invalidateChatId(body.model);
    }
  }

  // ═══ Fix 2026-07-08: axios 失敗後最後嘗試 Chrome（帶硬性逾時，避免掛起） ═══
  // WAF 黑洞下 Chrome 內 fetch 可能無限期掛起，必須設硬性逾時保護對話不卡死。
  // ═══ Fix 2026-07-08 (v2): AbortController 逾時通知 Chrome 清理，避免孤立 stream ═══
  // ═══ Fix 2026-07-08 (v5): WAF 模式時縮短備用逾時 ═══
  // ═══ Fix 2026-07-08 (v7): WAF 模式跳過 Chrome 備份路徑 ═══
  // 主路徑 Chrome 已失敗（wafMode 時被跳過，非 wafMode 時也逾時了），
  // 備份路徑再試 Chrome 只是重複浪費時間。直接跳過，端點回應更快。
  const BACKUP_CHROME_TIMEOUT_MS = _inWafMode
    ? 8000
    : _chromeReady
      ? 15000
      : 30000;
  if (
    !_inWafMode &&
    process.env.DISABLE_BROWSER !== "true" &&
    process.env.CHROME_DISABLED !== "true"
  ) {
    const chromeAbort = new AbortController();
    const chromeReq = (async () => {
      const chromeFetch = getChromeFetch();
      if (!chromeFetch) return null;
      return chromeFetch.sendChatRequest(
        body,
        currentAccount,
        chromeAbort.signal,
      );
    })();
    const timeout = new Promise((resolve) => {
      const tid = setTimeout(() => {
        chromeAbort.abort(
          new Error(
            `Chrome backup request timed out (${BACKUP_CHROME_TIMEOUT_MS / 1000}s)`,
          ),
        );
        resolve(null);
      }, BACKUP_CHROME_TIMEOUT_MS);
      chromeReq.finally(() => clearTimeout(tid));
    });
    const result = await Promise.race([chromeReq, timeout]);
    if (result && result.status && result.response) {
      logger.network(`[Chrome Fetch] 備用路徑成功`, "REQUEST");
      return result;
    }
    if (result === null) {
      logger.warn(
        `[Chrome Fetch] 備用路徑逾時 (${BACKUP_CHROME_TIMEOUT_MS / 1000}s)，跳過`,
        "REQUEST",
      );
    }
  }

  return { status: false, response: null };
};

/**
 * 產生chat_id
 * @param {string} currentToken
 * @param {string} model
 * @param {Object} [account] - 目前帳戶物件（用於解析帳號級代理）
 * @returns {Promise<string|null>} 回傳產生的chat_id，如果失敗則回傳null
 */
const generateChatID = async (currentToken, model, account) => {
  // 直接走 axios + SSXMOD cookie 繞過 WAF
  // Chrome Fetch createChat 不走 page.evaluate（Node fetch 被 WAF 擋），跳過以省時
  try {
    const chatBaseUrl = getChatBaseUrl();
    const proxyAgent = getProxyAgent(account);

    const requestConfig = {
      timeout: 20000,
      headers: {
        "sec-ch-ua-platform": '"Windows"',
        authorization: `Bearer ${currentToken}`,
        referer: `${chatBaseUrl}/`,
        "accept-language": "zh-CN,zh;q=0.9",
        "sec-ch-ua":
          '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "content-type": "application/json",
        "bx-v": "2.5.36",
        accept: "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        source: "web",
        version: "0.3.12",
        timezone: new Date().toString().replace(/GMT\+0800/, "GMT+0800"),
        "x-request-id": generateUUID(),
        connection: "keep-alive",
        cookie: `token=${currentToken};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
        host: chatBaseUrl.replace("https://", ""),
        origin: chatBaseUrl,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    };

    if (proxyAgent) {
      requestConfig.httpsAgent = proxyAgent;
      requestConfig.proxy = false;
    }

    const response_data = await axios.post(
      `${chatBaseUrl}/api/v2/chats/new`,
      {
        title: "New Chat",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: new Date().getTime(),
      },
      requestConfig,
    );

    return response_data.data?.data?.id || null;
  } catch (error) {
    logger.error("產生chat_id失敗", "CHAT", "", error.message);
    return null;
  }
};

module.exports = {
  sendChatRequest,
  generateChatID,
  getCachedChatId,
  invalidateChatId,
};
