/**
 * Curl Fetch Proxy — 用 curl-impersonate 替代 Chrome headless 繞 WAF
 *
 * 優勢：
 *   - 無需瀏覽器進程（CPU/記憶體佔用↓↓↓）
 *   - 無喇叭噪音
 *   - TLS 指紋模擬 Chrome 116 繞過 Cloudflare WAF
 *
 * 流程：
 *   1. 首次請求時用 curl-impersonate 取得 WAF cookies
 *   2. 後續 API 請求帶上 cookies + Bearer token
 *   3. SSE 串流透過 child_process.spawn 即時橋接
 *
 * 依賴: ~/.local/bin/curl_chrome116（curl-impersonate）
 */

const { spawn, execSync } = require("child_process");
const { PassThrough } = require("stream");
const { logger } = require("./logger");
const accountManager = require("./account");
const { getChatBaseUrl } = require("./proxy-helper");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── curl-impersonate 路徑偵測 ───
const CURL_PATHS = [
  path.join(os.homedir(), ".local/bin/curl_chrome116"),
  path.join(os.homedir(), ".local/bin/curl-impersonate-chrome"),
  "/usr/local/bin/curl_chrome116",
  "/usr/local/bin/curl-impersonate-chrome",
];

let _curlBin = null;
function findCurl() {
  if (_curlBin) return _curlBin;
  for (const p of CURL_PATHS) {
    if (fs.existsSync(p)) {
      _curlBin = p;
      logger.success(`curl-impersonate: ${p}`, "CURL");
      return p;
    }
  }
  return null;
}

// ─── Cookie 快取（WAF cookies） ───
let _wafCookies = null;
let _wafCookieTime = 0;
const COOKIE_TTL = 300_000; // 5 分鐘刷新

// ─── 斷路器 ───
const CB = {
  failures: 0,
  lastAttempt: 0,
  cooldown: 5000,
  disabled: false,
};

// ─── chat challenge 暫存（2026-10-18）──────────────────────
// curlSse 只把 stdout 轉發到 stream，不解析內容，導致 Qwen 的
// challenge 幀 {ret:['FAIL_SYS_USER_VALIDATE',...被挤爆啦]} 被上層誤判為
// 「SSE 無有效內容」而走傳輸失敗降級（反覆重試反而 hammer Qwen）。
// 這裡在轉發前先偵測，讓呼叫方能分流。
let _challengePayload = null;

const _CHALLENGE_RE =
  /fail_sys_user_validate|rgv587|被挤爆|_____tmd_____|action=captcha|x5secdata/i;

/**
 * 掃描 SSE 資料是否含 Qwen chat challenge 訊號
 * @param {string} text - SSE 資料片段（累積後）
 * @returns {boolean} 是否為 challenge
 */
function _looksLikeChallenge(text) {
  return !!text && _CHALLENGE_RE.test(text);
}

// SSE 資料可能被切成多個 chunk，challenge 關鍵字跨邊界，
// 因此累積前 4KB 再比對，避免漏判。
const _CHALLENGE_BUF_MAX = 4096;
let _challengeBuf = "";

// ═══ Fix 2026-10-21: 內容檢查用緩衝（per-stream，非全域）══════════
// 呼叫端需要在「不消費下游 stream」的前提下判斷是否收到有效內容，
// 因此在 curlSse 轉發時同步累積一份原始 SSE 文字副本。
// 掛在 stream 物件上（而非模組全域）→ 並行請求互不干擾。
// 容量放大到 64KB：Qwen 前幾幀可能是 phase/usage 等不含 content 的幀，
// 4096 不足以等到第一個帶 content 的幀 → 誤判為 WAF 阻擋。
const _PEEK_BUF_MAX = 65536;
const _peekKey = Symbol("qwenPeekBuf");

/**
 * 讀取某串流累積的 SSE 副本（不消費串流本身）
 *
 * ═══ Fix 2026-10-21: 檢查期必須「不消費」下游 stream ═══
 * 【原缺陷】呼叫端（request.js）為判定「是否有有效內容」而掛
 *           curlStream.on("data") → PassThrough 立即進入 flowing mode →
 *           累積緩衝被檢查期吃掉 → controller 再掛 listener 時首幀已遺失。
 *           症狀：回應永遠少第一個字（「快取」→「取」、「數到20」→「, 2,」）。
 * 【修正】改用 peek 讀取 curl-fetch 端自行累積的原始 SSE 文字，
 *           完全不觸碰下游 stream → stream 維持 paused，controller 完整收資料。
 *
 * @param {import("stream").PassThrough} stream - 目標串流
 * @returns {string} 已累積的 SSE 內容（副本）
 */
function peekBuffered(stream) {
  return stream?.[_peekKey] || "";
}

/**
 * 取出並清除暫存的 challenge 訊號
 * @returns {string|null} 命中的 challenge 訊號
 */
function takeChallengePayload() {
  const v = _challengePayload;
  _challengePayload = null;
  return v;
}

/**
 * 取出並清除累積緩衝
 *
 * curlSse 在 data listener 掛載前就可能已把首幀寫入下游 stream，
 * 呼叫方掛載 listener 後會讀不到 → 這裡保留一份供上層補讀。
 *
 * @returns {string} 已累積的 SSE 內容
 */
function takeBuffered() {
  const v = _challengeBuf;
  _challengeBuf = "";
  return v;
}

function _cbFail() {
  CB.failures++;
  CB.lastAttempt = Date.now();
  CB.cooldown = Math.min(CB.cooldown * 2, 60_000);
  if (CB.failures >= 5) CB.disabled = true;
}

function _cbSuccess() {
  CB.failures = 0;
  CB.disabled = false;
  CB.cooldown = 5000;
}

function _cbCanTry() {
  if (CB.disabled) return false;
  return Date.now() - CB.lastAttempt > CB.cooldown;
}

// ─── WAF Cookie 取得 ───
async function _getWafCookies() {
  const now = Date.now();
  if (_wafCookies !== null && now - _wafCookieTime < COOKIE_TTL)
    return _wafCookies;

  const curl = findCurl();
  if (!curl) return null;

  const chatBase = getChatBaseUrl();
  // curl-impersonate 的 TLS 指紋通常已足夠繞 WAF
  // 即使拿不到 cookies，也回傳空字串讓後續請求嘗試
  return new Promise((resolve) => {
    const args = [
      "-sS",
      "-v",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "10",
      `${chatBase}/`,
    ];

    const proc = spawn(curl, args, { timeout: 15000 });
    let stderr = "";

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      const httpCode = (stderr.match(/< HTTP\/[\d.]+ (\d+)/) || [])[1] || "0";

      // 解析 Set-Cookie
      const cookies = [];
      for (const line of stderr.split("\n")) {
        const m = line.match(/< [Ss]et-[Cc]ookie:\s*(.+)/);
        if (m) cookies.push(m[1].split(";")[0].trim());
      }

      const cookieStr = cookies.join("; ");
      _wafCookies = cookieStr || ""; // 空字串也 OK，curl TLS 指紋可能已足夠
      _wafCookieTime = Date.now();

      if (cookies.length > 0) {
        logger.info(
          `取得 ${cookies.length} 個 WAF cookies (HTTP ${httpCode})`,
          "CURL",
        );
      } else {
        logger.info(
          `WAF cookie 無需（TLS 指紋已足夠, HTTP ${httpCode}）`,
          "CURL",
        );
      }
      resolve(_wafCookies);
    });

    proc.on("error", () => resolve("")); // 錯誤時也回傳空字串嘗試
  });
}

// ─── 核心：用 curl-impersonate 發送 SSE 請求 ───
/**
 * 透過 curl-impersonate 發送 SSE 請求，即時橋接串流到 PassThrough
 *
 * @param {object} opts
 * @param {string} opts.url - 完整 URL
 * @param {object} opts.headers - 請求 headers
 * @param {string} opts.body - POST body
 * @param {string} opts.wafCookies - WAF cookies
 * @param {PassThrough} opts.stream - 輸出串流
 * @returns {Promise<boolean>} 成功與否
 */
function curlSse({ url, headers, body, wafCookies, stream }) {
  const curl = findCurl();
  if (!curl) return Promise.resolve(false);

  // 每次請求重置 challenge 偵測狀態（避免上一輪的殘留誤判本輪）
  _challengeBuf = "";
  _challengePayload = null;
  // ═══ Fix 2026-10-21: 初始化 per-stream 內容檢查緩衝 ═══
  stream[_peekKey] = "";

  return new Promise((resolve) => {
    // ═══ Fix 2026-10-18: body 改走 stdin，禁止放 argv ═══
    // Linux 單一 argv 上限約 128KiB；大 context 經 JSON/UTF-8 後
    // 會觸發 E2BIG: argument list too long。curl 用 @- 從 stdin 讀 body。
    const args = [
      "-sS",
      "--max-time",
      "60",
      "--no-buffer",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      "Accept: text/event-stream",
      "--data-binary",
      "@-",
    ];

    // 加入自訂 headers
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "content-type") continue;
      if (k.toLowerCase() === "accept") continue;
      args.push("-H", `${k}: ${v}`);
    }

    // ═══ Fix 2026-07-12: 避免 -b 與 cookie header 衝突 ═══
    // 若 headers 已含 cookie（含 auth + WAF），不再用 -b 重複傳送
    const hasCookieHeader = Object.keys(headers).some(
      (k) => k.toLowerCase() === "cookie",
    );
    if (wafCookies && !hasCookieHeader) {
      args.push("-b", wafCookies);
    }

    args.push(url);

    const proc = spawn(curl, args, {
      timeout: 65000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // stdin 只可能因子進程提前結束收到 EPIPE；不應升級成請求錯誤
    proc.stdin.on("error", () => {});
    proc.stdin.end(typeof body === "string" ? body : String(body ?? ""));

    let resolved = false;

    proc.stdout.on("data", (chunk) => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
      // ═══ Fix 2026-10-18: 轉發前偵測 chat challenge ═══
      const text = chunk.toString();
      if (!_challengePayload && _challengeBuf.length < _CHALLENGE_BUF_MAX) {
        _challengeBuf = (_challengeBuf + text).slice(-_CHALLENGE_BUF_MAX);
        if (_looksLikeChallenge(_challengeBuf)) {
          _challengePayload =
            _challengeBuf.match(/FAIL_SYS_USER_VALIDATE[^"]*/i)?.[0] ||
            _challengeBuf.match(/RGV587[^"]*/i)?.[0] ||
            "chat_challenge";
          logger.warn("[WAF] curl 收到 chat challenge 幀", "CURL");
        }
      }
      // ═══ Fix 2026-10-21: 累積內容檢查副本（不影響下游 stream）═══
      // 呼叫端用 peekBuffered(stream) 判斷「是否有有效內容」，
      // 必須在「不消費下游 stream」的前提下取得資料，否則首幀會被吃掉。
      if (stream[_peekKey].length < _PEEK_BUF_MAX) {
        stream[_peekKey] = (stream[_peekKey] + text).slice(0, _PEEK_BUF_MAX);
      }
      try {
        stream.write(chunk);
      } catch {}
    });

    proc.stderr.on("data", (d) => {
      const msg = d.toString();
      // curl stderr 通常為進度資訊，過濾掉
      if (msg.includes("Warning") || msg.includes("error")) {
        logger.warn(`curl stderr: ${msg.slice(0, 120)}`, "CURL");
      }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        if (code === 0) {
          resolve(true);
        } else {
          logger.warn(`curl 退出 code=${code}`, "CURL");
          resolve(false);
        }
      }
      try {
        stream.end();
      } catch {}
    });

    proc.on("error", (e) => {
      logger.warn(`curl 執行錯誤: ${e.message}`, "CURL");
      if (!resolved) resolve(false);
      try {
        stream.destroy(e);
      } catch {}
    });
  });
}

// ─── 核心：用 curl-impersonate 發送普通 HTTP 請求 ───
function curlRequest({
  url,
  method = "GET",
  headers = {},
  body,
  wafCookies,
  timeout = 15000,
}) {
  const curl = findCurl();
  if (!curl)
    return Promise.resolve({
      ok: false,
      status: 0,
      text: "curl-impersonate not found",
    });

  return new Promise((resolve) => {
    const args = [
      "-sS",
      "--max-time",
      String(Math.floor(timeout / 1000)),
      "-X",
      method,
      "-w",
      "\n__HTTP_CODE__%{http_code}",
    ];

    for (const [k, v] of Object.entries(headers)) {
      args.push("-H", `${k}: ${v}`);
    }

    if (body) {
      // ═══ Fix 2026-10-18: body 一律走 stdin，避免大 body 觸發 E2BIG ═══
      args.push("--data-binary", "@-");
    }

    if (wafCookies) {
      args.push("-b", wafCookies);
    }

    args.push(url);

    const proc = spawn(curl, args, {
      timeout: timeout + 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.on("error", () => {});
    if (body) {
      proc.stdin.end(typeof body === "string" ? body : JSON.stringify(body));
    } else {
      proc.stdin.end();
    }
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", () => {
      // 分離 HTTP code
      const idx = stdout.lastIndexOf("__HTTP_CODE__");
      const httpCode = idx >= 0 ? parseInt(stdout.slice(idx + 13), 10) : 0;
      const responseBody = idx >= 0 ? stdout.slice(0, idx) : stdout;

      resolve({
        ok: httpCode >= 200 && httpCode < 400,
        status: httpCode,
        text: responseBody,
      });
    });

    proc.on("error", (e) => {
      resolve({ ok: false, status: 0, text: e.message });
    });
  });
}

// ─── 匯出 ───
module.exports = {
  findCurl,
  _getWafCookies,
  curlSse,
  curlRequest,
  _cbCanTry,
  _cbFail,
  _cbSuccess,
  takeChallengePayload,
  takeBuffered,
  peekBuffered,
  CB,
};
