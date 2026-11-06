/**
 * upstream-error.js — 上游錯誤分類與 chat challenge 熔斷
 *
 * 移植自原作者 Rfym21/Qwen2API commit 81b75ad（2026-09-26），
 * 針對 Qwen 白天高負載時段的「被挤爆啦」風控驗證。
 *
 * 【原實測數據，issue #180，2026-09-23~26 生產環境】
 *   502 次 chat 請求中 477 次被挑戰，全部發生在 07:00Z–22:00Z（UTC）；
 *   25 次成功全在夜間 UTC。同一帳戶白天被挑、夜間通過。
 *   建立 chat 與上傳 history 在挑戰前幾秒仍成功。
 *   → 不是帳戶問題，不是 context 大小問題，是 Qwen 尖峰時段主動風控。
 *
 * 【關鍵行為】
 *   - Qwen 回 HTTP 200 + JSON {ret:['FAIL_SYS_USER_VALIDATE','...被挤爆啦...']}
 *     沒有 choices，若不偵測會被誤包裝成「空成功」。
 *   - 連續 N 次 challenge → 全域熔斷 M 秒，期間不打 Qwen（避免 hammer）。
 *   - challenge 不對帳戶冷卻（它跟帳戶無關，與舊版的 recordChallenge 相反）。
 *   - 回 503 + Retry-After（舊版回 502/500 且無 Retry-After，客戶端不知何時重試）。
 */

const WAF_CHALLENGE_CODE = "upstream_waf_challenge";

// Qwen challenge 幀的特徵字串（任一命中即判定）
const WAF_SIGNAL_RE =
  /fail_sys_user_validate|rgv587|被挤爆|captcha|_____tmd_____|punish\?|action=captcha|x5secdata/i;

const CHAT_CHALLENGE_MESSAGE =
  "Qwen 上游繁忙，触发风控验证（被挤爆啦），請稍後重試 / " +
  "Qwen chat challenge: upstream busy, retry later";

/** 單次 challenge 的建議等待秒數 */
const CHAT_CHALLENGE_RETRY_AFTER_SECONDS = 30;
/** 連續幾次後開啟全域熔斷 */
const CHAT_BREAKER_STRIKES = 3;
/** 熔斷開啟秒數（期間所有帳戶共用同一出口 IP，一併受益） */
const CHAT_BREAKER_SECONDS = 60;

class UpstreamResponseError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "UpstreamResponseError";
    this.code = code;
    this.details = details;
  }
}

// ═══ 單一熔斷器（與原作者一致：同進程內所有帳戶共用同一出口 IP）═══
const chatBreaker = { strikes: 0, openUntil: 0 };

const resetChatChallengeBreaker = () => {
  chatBreaker.strikes = 0;
  chatBreaker.openUntil = 0;
};

/**
 * 記錄一次 challenge，回傳建議等待秒數。
 * 前 CHAT_BREAKER_STRIKES 次只回 Retry-After；達標則開啟全域熔斷。
 * @returns {number} Retry-After (s)
 */
const noteChatChallenge = () => {
  chatBreaker.strikes += 1;
  if (chatBreaker.strikes < CHAT_BREAKER_STRIKES) {
    return CHAT_CHALLENGE_RETRY_AFTER_SECONDS;
  }
  chatBreaker.openUntil = Date.now() + CHAT_BREAKER_SECONDS * 1000;
  return CHAT_BREAKER_SECONDS;
};

const chatChallengeError = (retryAfter, details) => {
  const error = new UpstreamResponseError(
    CHAT_CHALLENGE_MESSAGE,
    WAF_CHALLENGE_CODE,
    details,
  );
  error.retryAfter = retryAfter;
  return error;
};

/**
 * sendChatRequest 在建立 chat / 上傳 history 之前呼叫。
 * 熔斷開啟中直接丟錯，不浪費一次 round-trip。
 */
const assertChatChallengeBreakerClosed = () => {
  const remaining = Math.ceil((chatBreaker.openUntil - Date.now()) / 1000);
  if (remaining > 0) {
    throw chatChallengeError(remaining, { breakerOpen: true });
  }
};

const isWafChallengeError = (error) =>
  !!error &&
  (error.code === WAF_CHALLENGE_CODE ||
    (error instanceof UpstreamResponseError &&
      error.code === WAF_CHALLENGE_CODE));

/**
 * 從 payload 中找出 challenge 訊號（純函式，供測試）
 * @returns {string[]} 命中的訊號字串
 */
const findWafChallengeSignals = (payload) => {
  if (!payload || typeof payload !== "object") return [];
  return [
    payload.ret,
    payload.message,
    payload.data?.details,
    payload.data?.url,
    payload.data?.code,
    payload.error?.code,
  ]
    .flat(Infinity)
    .filter(Boolean)
    .map(String)
    .filter((item) => WAF_SIGNAL_RE.test(item));
};

/**
 * 偵測 challenge 並回傳正規化錯誤，或 null（不是 challenge）。
 * 注意 payload 可能就是 challenge 物件本身（Qwen 的回應）。
 */
const detectWafChallenge = (payload) => {
  const signals = findWafChallengeSignals(payload);
  if (!signals.length) return null;
  return { code: WAF_CHALLENGE_CODE, details: { signals } };
};

/**
 * Qwen Web 有時以 HTTP 200 + 普通 JSON 回 WAF/captcha 或業務失敗。
 * 這些幀沒有 choices，若直接跳過會被誤包裝成空成功或正常 stop。
 * @throws {UpstreamResponseError} challenge 或業務失敗時丟出
 */
const assertNoUpstreamFailure = (payload) => {
  const wafChallenge = detectWafChallenge(payload);
  if (wafChallenge) {
    throw chatChallengeError(noteChatChallenge(), wafChallenge.details);
  }

  if (!payload || typeof payload !== "object") return;

  const explicitError = payload.error;
  if (explicitError) {
    const rawMessage =
      typeof explicitError === "string"
        ? explicitError
        : typeof explicitError?.message === "string" && explicitError.message
          ? explicitError.message
          : explicitError?.message
            ? JSON.stringify(explicitError.message)
            : JSON.stringify(explicitError);
    const code =
      typeof explicitError?.code === "string" && explicitError.code
        ? explicitError.code
        : "upstream_error";
    throw new UpstreamResponseError(rawMessage, code, payload);
  }

  // Qwen 恢復生成：有 choices 即代表探測通過 → 關閉熔斷
  if (Array.isArray(payload.choices)) {
    resetChatChallengeBreaker();
  }
};

const chatBreakerState = () => ({
  strikes: chatBreaker.strikes,
  openUntil: chatBreaker.openUntil,
  open: chatBreaker.openUntil > Date.now(),
  remainingSeconds: Math.max(
    0,
    Math.ceil((chatBreaker.openUntil - Date.now()) / 1000),
  ),
});

module.exports = {
  WAF_CHALLENGE_CODE,
  WAF_SIGNAL_RE,
  CHAT_CHALLENGE_MESSAGE,
  CHAT_CHALLENGE_RETRY_AFTER_SECONDS,
  CHAT_BREAKER_STRIKES,
  CHAT_BREAKER_SECONDS,
  UpstreamResponseError,
  assertNoUpstreamFailure,
  assertChatChallengeBreakerClosed,
  chatChallengeError,
  chatBreakerState,
  detectWafChallenge,
  findWafChallengeSignals,
  isWafChallengeError,
  noteChatChallenge,
  resetChatChallengeBreaker,
};
