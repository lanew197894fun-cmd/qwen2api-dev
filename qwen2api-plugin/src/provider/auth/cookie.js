/**
 * auth/cookie.js — Cookie-based 認證
 *
 * 三種模式（依優先級）：
 *   1. sessionToken — 單一 token 字串，設為 cookie 的 token 欄位
 *   2. cookieString — 完整 cookie 字串，直接作為 Cookie header
 *   3. login — 帳密登入（需要 puppeteer 或自訂登入函數）
 *
 * 支援自動重試與刷新（重新登入）。
 * 適用於：ChatGPT Web（session token / access token）、Claude Web 等。
 */

const log = {
  info: (...a) => console.log("[auth:cookie]", ...a),
  warn: (...a) => console.warn("[auth:cookie]", ...a),
  error: (...a) => console.error("[auth:cookie]", ...a),
};

export function createCookieAuth(cfg) {
  const mode = cfg.mode || "sessionToken"; // sessionToken | cookieString | login

  // sessionToken 模式
  const sessionToken = cfg.sessionToken || "";

  // cookieString 模式
  const cookieString = cfg.cookieString || "";

  // login 模式
  const loginUrl = cfg.loginUrl || "";
  const username = cfg.username || "";
  const password = cfg.password || "";
  const loginSelector = cfg.loginSelector || 'input[type="email"]';
  const passSelector = cfg.passSelector || 'input[type="password"]';
  const submitSelector = cfg.submitSelector || 'button[type="submit"]';
  const cookieDomains = cfg.cookieDomains || [];

  // 運行時狀態
  let currentCookie = "";
  let lastRefresh = 0;
  let _refreshing = false;

  /** 從 sessionToken 建構 cookie */
  function buildCookieFromToken() {
    // ChatGPT 格式：session_token=xxx
    const domains =
      cookieDomains.length > 0
        ? cookieDomains
        : [".chatgpt.com", ".chat.openai.com"];
    if (sessionToken) {
      return domains
        .map((d) => `session_token=${sessionToken}; Domain=${d}; Path=/`)
        .join("; ");
    }
    return "";
  }

  /** 使用 puppeteer 進行登入—僅在 login 模式且 Node.js 環境下可用 */
  async function loginWithPuppeteer() {
    if (!loginUrl || !username || !password) {
      throw new Error(
        "[auth:cookie] login 模式需要 loginUrl / username / password",
      );
    }

    let puppeteer;
    try {
      puppeteer = await import("puppeteer");
    } catch {
      // 嘗試從全局路徑載入
      try {
        puppeteer = await import("puppeteer-core");
      } catch {
        throw new Error(
          "[auth:cookie] 需要 puppeteer 或 puppeteer-core 進行自動登入",
        );
      }
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      // 設定較短的 timeout
      await page.setDefaultTimeout(30000);

      log.info(`${cfg.name || "?"} 登入 ${loginUrl}...`);
      await page.goto(loginUrl, { waitUntil: "networkidle2" });

      // 填入帳密
      await page.waitForSelector(loginSelector);
      await page.type(loginSelector, username);
      if (passSelector) {
        await page.waitForSelector(passSelector);
        await page.type(passSelector, password);
      }

      // 點擊提交
      if (submitSelector) {
        await page.waitForSelector(submitSelector);
        await page.click(submitSelector);
      }

      // 等待導航完成
      await page.waitForNavigation({ timeout: 30000 }).catch(() => {});
      // 額外等待確保 cookie 寫入
      await new Promise((r) => setTimeout(r, 2000));

      // 提取 cookie
      const cookies = await page.cookies();
      currentCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      log.info(`${cfg.name || "?"} 登入成功，取得 ${cookies.length} 個 cookie`);
      lastRefresh = Date.now();
      return true;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  return {
    type: "cookie",

    init() {
      if (mode === "sessionToken" && sessionToken) {
        currentCookie = buildCookieFromToken();
        log.info(`${cfg.name || "?"} sessionToken 模式就緒`);
        return;
      }

      if (mode === "cookieString" && cookieString) {
        currentCookie = cookieString;
        log.info(`${cfg.name || "?"} cookieString 模式就緒`);
        return;
      }

      if (mode === "login") {
        // login 模式在 init 時不做實際登入（延遲到首次 refresh）
        log.info(`${cfg.name || "?"} login 模式（延遲登入）`);
        return;
      }

      throw new Error(
        `[auth:cookie] ${cfg.name || "?"} 無法初始化（mode=${mode}，缺少必要參數）`,
      );
    },

    getHeaders() {
      return currentCookie ? { Cookie: currentCookie } : {};
    },

    async refresh() {
      if (_refreshing) {
        while (_refreshing) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return true;
      }

      _refreshing = true;
      try {
        if (mode === "login") {
          return await loginWithPuppeteer();
        }

        if (mode === "sessionToken" && sessionToken) {
          currentCookie = buildCookieFromToken();
          lastRefresh = Date.now();
          return true;
        }

        if (mode === "cookieString" && cookieString) {
          currentCookie = cookieString;
          lastRefresh = Date.now();
          return true;
        }

        return false;
      } catch (e) {
        log.error(`${cfg.name || "?"} cookie 刷新失敗: ${e.message}`);
        return false;
      } finally {
        _refreshing = false;
      }
    },

    isHealthy() {
      return currentCookie.length > 0;
    },

    toJSON() {
      return {
        type: "cookie",
        mode,
        ready: currentCookie.length > 0,
        cookieLen: currentCookie.length,
        lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      };
    },
  };
}
