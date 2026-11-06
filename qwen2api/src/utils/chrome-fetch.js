/**
 * Chrome Fetch Proxy v3
 * 使用 headless Chrome 透過 page.evaluate 繞過阿里雲 WAF JS challenge。
 *
 * 流程:
 *   1. 啟動 headless Chrome（無視窗）
 *   2. 導航至 chat.qwen.ai 通過 WAF JS challenge
 *   3. 設定 token Cookie 讓瀏覽器處於登入狀態
 *   4. 透過 page.evaluate 在瀏覽器 context 中發送 API 請求
 *   5. SSE 串流透過 exposeFunction 橋接到 Node.js stream
 *
 * 依賴: google-chrome-stable, puppeteer-core
 */

const puppeteer = require("puppeteer-core");
const { PassThrough } = require("stream");
const { logger } = require("./logger");

// 固定從一次帳號提取 token (不 round-robin)
const accountManager = require("./account");
const { getChatBaseUrl } = require("./proxy-helper");

const CHROME_PATHS = [
  // Puppeteer 自帶 Chrome（推薦：隔離、獨立 profile、指紋不同）
  `${require("os").homedir()}/.cache/puppeteer/chrome/linux-151.0.7922.34/chrome-linux64/chrome`,
  // 系統 Chrome/Chromium
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.PROGRAMFILES || ""}\\Google\\Chrome\\Application\\chrome.exe`,
];

// 全域單例
let instance = null;
let initPromise = null;

// ═══ Fix 2026-07-08: 暫時頁面時序累加器（合併批次為一行） ═══
// 避免每個暫時頁面獨立 log（建立/導航/就緒 × N 次）造成大量刷屏。
// 改為累計所有頁面耗時，3 秒靜默後一次性輸出，格式與心跳行一致。
const _pageTimings = [];
let _pageFlushTimer = null;
const _flushPageTimings = () => {
  if (!_pageTimings.length) return;
  const times = _pageTimings.splice(0);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const _range = min === max ? `⚡ ${avg}ms` : `⚡ ${min}~${max}ms (φ${avg}ms)`;
  logger.info(`🟢 暫時頁面 | ${times.length} 個就緒 | ${_range}`, "CHROME");
};

// ═══ Chrome Fetch 斷路器（指數退避 + 永久禁用 + WAF 模式感知） ═══
// ═══ Fix 2026-07-08 (v5): 加速恢復 + WAF 模式匯出 ═══
// 問題：原永久禁用 5 分鐘內所有請求強走 axios，但 WAF 通常 1-2 分鐘內恢復，
// 5 分鐘空窗期過長。改為階梯式恢復：首次 2 分鐘，第二次 3 分鐘，三次+ 1 分鐘。
// 同時匯出斷路器狀態供 request.js 判斷是否應縮短 Chrome 逾時。
const CB = {
  failures: 0,
  lastAttempt: 0,
  cooldown: 5000, // 初始 5s
  maxCooldown: 300000, // 最長 5min
  threshold: 0, // 0 = 每次失敗都退避
  resetAfter: 600000, // 成功後 10min 重設計數
  lastSuccess: 0,
  _warned: false, // 避免重複噴斷路器訊息
  _permanentDisabled: false, // ═══ Fix: 超過最大冷卻後永久禁用 ═══
  _permanentWarned: false,
  // ═══ Fix 2026-07-08 (v5): WAF 狀態感知 ═══
  _wafMode: false, // WAF 阻擋模式啟用
  _consecWafBlocks: 0, // 連續 WAF 阻擋次數
  _permanentDisableCount: 0, // 永久禁用觸發次數（用於階梯式恢復）
};

function _cbShouldTry() {
  // ═══ Fix: 永久禁用後不再嘗試 ═══
  if (CB._permanentDisabled) {
    if (!CB._permanentWarned) {
      const { logger } = require("./logger");
      logger.warn(
        "[CHROME] ⛔ Chrome Fetch 已永久禁用（連續失敗過多），使用 Axios",
        "CHROME",
      );
      CB._permanentWarned = true;
    }
    return false;
  }
  if (CB.failures === 0) {
    CB._warned = false;
    return true;
  }
  const elapsed = Date.now() - CB.lastAttempt;
  return elapsed >= CB.cooldown;
}

function _cbRecordFail(isWaf) {
  CB.failures++;
  CB.lastAttempt = Date.now();
  CB.cooldown = Math.min(CB.cooldown * 2, CB.maxCooldown);
  CB._warned = false; // 下次可重新警告
  // ═══ Fix 2026-07-08 (v5): WAF 阻擋模式追蹤 ═══
  if (isWaf) {
    CB._consecWafBlocks++;
    if (CB._consecWafBlocks >= 3) {
      CB._wafMode = true;
    }
  } else {
    // 非 WAF 失敗不累加 consecWafBlocks（可能 3 次後仍重設）
    // 但保留已進入的 wafMode
  }
  // ═══ Fix 2026-07-08 (v5): 階梯式永久禁用恢復 ═══
  // 原固定 12 次 + 5 分鐘恢復。現改為：
  // - 第 1 次永久禁用：4 次失敗 → 2 分鐘恢復
  // - 第 2 次永久禁用：4 次失敗 → 3 分鐘恢復
  // - 第 3+ 次永久禁用：4 次失敗 → 1 分鐘恢復（快速恢復以防 WAF 短暫波動）
  // ═══ Fix 2026-07-08 (v7): 閾值 8→4 ═══
  // 理由：Chrome SSE page.evaluate 在 WAF 阻擋時一致逾時（20s+），
  // 4 次失敗足以確認 Chrome 無法正常運作，無需等到 8 次才永久禁用。
  const PERM_DISABLE_THRESHOLD = 4;
  // ═══ Fix 2026-07-09 (v2): 延長第 3+ 次永久禁用恢復時間 ═══
  // 原 1min 太短：WAF 風暴時 Chrome 快速恢復→立刻失敗→再次永久禁用→循環，
  // 每 1min 觸發一次 Chrome init（耗 3-5s），浪費資源且不提供價值。
  // 階梯式延長：2min → 5min → 10min，風暴期間大幅減少重試頻率。
  const RECOVERY_TIMES = [120000, 300000, 600000]; // 2min, 5min, 10min
  if (CB.failures >= PERM_DISABLE_THRESHOLD) {
    CB._permanentDisabled = true;
    CB._permanentDisableCount++;
    process.env.CHROME_DISABLED = "true";
    process.env.DISABLE_BROWSER = "true";
    // 永久禁用後定時恢復（階梯式）
    if (!CB._recoverTimer) {
      const idx = Math.min(
        CB._permanentDisableCount - 1,
        RECOVERY_TIMES.length - 1,
      );
      const recoverMs = RECOVERY_TIMES[idx];
      const { logger } = require("./logger");
      logger.info(
        `[CHROME] ⏰ 永久禁用 #${CB._permanentDisableCount}，${Math.round(recoverMs / 1000)}s 後自動恢復...`,
        "CHROME",
      );
      CB._recoverTimer = setTimeout(() => {
        if (CB._permanentDisabled) {
          logger.info(
            "[CHROME] ⏰ 定時恢復檢查：嘗試重啟 Chrome Fetch...",
            "CHROME",
          );
          CB._permanentDisabled = false;
          CB._permanentWarned = false;
          process.env.CHROME_DISABLED = "false";
          process.env.DISABLE_BROWSER = "false";
          // 重設斷路器計數（保留 _permanentDisableCount 供下次階梯判斷）
          CB.failures = 0;
          CB.cooldown = 5000;
          // ═══ Fix 2026-07-08 (v5): 恢復時也清除 WAF 模式 ═══
          CB._wafMode = false;
          CB._consecWafBlocks = 0;
        }
        CB._recoverTimer = null;
      }, recoverMs);
      CB._recoverTimer.unref();
    }
  }
}

function _cbRecordSuccess() {
  CB.failures = 0;
  CB.cooldown = 5000;
  CB.lastSuccess = Date.now();
  CB._warned = false;
  CB._permanentDisabled = false; // ═══ Fix: 成功時重設永久禁用 ═══
  CB._permanentWarned = false;
  // ═══ Fix 2026-07-08 (v5): 成功時清除 WAF 模式 ═══
  CB._wafMode = false;
  CB._consecWafBlocks = 0;
  CB._permanentDisableCount = 0; // 完全恢復後重設計數
}

class ChromeFetch {
  constructor() {
    this.browser = null;
    this.page = null;
    this.ready = false;
    this.reqSeq = 0;
    this.callbacks = new Map();
    this._initLock = null;
    this.chatBaseUrl = getChatBaseUrl();
    // ═══ Fix 2026-07-20: Chrome 未安裝一次性標記 ═══
    this._chromeNotFound = process.env.CHROME_NOT_FOUND === "true";
    this._chromeNotFoundWarned = false;
  }

  findChrome() {
    // 先掃描固定路徑
    for (const p of CHROME_PATHS) {
      try {
        if (require("fs").existsSync(p)) return p;
      } catch {}
    }
    // 動態掃描 ~/.cache/puppeteer/chrome/ 下的版本目錄
    const puppeteerDir = `${require("os").homedir()}/.cache/puppeteer/chrome`;
    try {
      const fs = require("fs");
      const path = require("path");
      if (fs.existsSync(puppeteerDir)) {
        const versions = fs.readdirSync(puppeteerDir)
          .filter((d) => d.startsWith("linux"))
          .sort()
          .reverse(); // 最新版本優先
        for (const v of versions) {
          const bin = path.join(puppeteerDir, v, "chrome-linux64", "chrome");
          if (fs.existsSync(bin)) return bin;
        }
      }
    } catch {}
    return null;
  }

  /**
   * 清理 Chrome profile 鎖檔（避免前次異常退出導致鎖定）
   */
  _cleanProfileLock(profileDir) {
    const fs = require("fs");
    const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    for (const lock of locks) {
      const fp = require("path").join(profileDir, lock);
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {}
    }
  }

  /**
   * ═══ Fix 2026-07-07: 建立新頁面 + WAF 繞過 ═══
   * 為 POST/SSE 請求建立隔離的暫時頁面，
   * 避免 POST fetch 導致 main page (this.page) 被關閉。
   *
   * 流程：
   *   1. 建立新頁面
   *   2. 導航至 chat.qwen.ai 通過 WAF 挑戰
   *   3. 設定 token Cookie
   *   4. 等待 WAF 通過（頁面 title 含 qwen/chat 等）
   *   5. 回傳 page 物件供調用方使用
   *
   * @returns {Promise<Page|null>} Puppeteer Page 或 null
   */
  async _freshInitPage() {
    if (!this.browser || !this.browser.isConnected()) return null;
    const account = accountManager.getAccount();
    const token = account ? account.token : "";
    let page = null;
    const _t0 = Date.now();
    // ═══ WAF 模式時縮短所有逾時，避免浪費時間 ═══
    const _wafActive = CB._wafMode;
    const _OVERALL_TIMEOUT = _wafActive ? 12000 : 25000;
    const _NAV_TIMEOUT = _wafActive ? 8000 : 20000;
    const _NETWORK_IDLE_TIMEOUT = _wafActive ? 5000 : 15000;
    const _NEWPAGE_TIMEOUT = _wafActive ? 8000 : 15000;
    try {
      page = await Promise.race([
        this.browser.newPage(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("newPage 逾時")), _NEWPAGE_TIMEOUT),
        ),
      ]);
      // ═══ Fix 2026-07-08 (v5): 隨機化 viewport 避免 TLS 指紋辨識 ═══
      // WAF 透過 viewport 大小、WebGL 指紋等識別自動化瀏覽器。
      // 每次暫時頁面使用隨機解析度，降低被辨識為 headless Chrome 的機率。
      const _vpW = 1024 + Math.floor(Math.random() * 256); // 1024~1280
      const _vpH = 600 + Math.floor(Math.random() * 280); // 600~880
      await page.setViewport({ width: _vpW, height: _vpH });
      const _t1 = Date.now();
      // ═══ Fix 2026-07-08 (v5): 反 WAF 繞過 — 先導航至隨機頁面再跳轉 ═══
      // 直接導航至 chat.qwen.ai 容易被 WAF 挑戰頁面攔截。
      // 改為先導航至一個外部頁面建立正常瀏覽 session，再 via evaluate 跳轉。
      // 此舉可讓 WAF 認為流量來自真實瀏覽器而非直接存取 API。
      try {
        await page.goto("https://www.google.com", {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
      } catch {
        // google 連線失敗不影響主流程，繼續嘗試直接導航 chat.qwen.ai
      }
      // 導航至 chat.qwen.ai 觸發 WAF 挑戰
      const navRes = await page.goto(this.chatBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: _NAV_TIMEOUT,
      });
      const _t2 = Date.now();
      // 設定 token Cookie（CDP 方式，不依賴 frame）
      if (token && navRes) {
        const status = navRes.status();
        if (status !== 403 && status !== 503) {
          try {
            const cdp = await page.createCDPSession();
            await cdp.send("Network.setCookie", {
              name: "token",
              value: token,
              domain: ".chat.qwen.ai",
              path: "/",
              httpOnly: false,
              secure: true,
            });
          } catch {}
        }
      }
      // 等待 WAF 挑戰完成（最長 10s）
      try {
        await page.waitForFunction(
          () => {
            const t = document.title.toLowerCase();
            return (
              t.includes("qwen") ||
              t.includes("千问") ||
              t.includes("chat") ||
              t.includes("studio")
            );
          },
          { timeout: 10000 },
        );
      } catch {
        // WAF 超時非致命，繼續嘗試
      }
      // ═══ Fix 2026-07-08 (v2): 等待 SPA 載入完成 ═══
      // page.evaluate 在 SPA 尚未 idle 時會阻塞（Runtime.callFunctionOn timed out），
      // 導致 SSE 串流請求無限期掛起。waitForNetworkIdle 確保 VDOM 掛載後才執行 evaluate。
      // ═══ Fix 2026-07-08 (v7): WAF 模式縮短 timeout ═══
      try {
        await page.waitForNetworkIdle({
          idleTime: 500,
          timeout: _NETWORK_IDLE_TIMEOUT,
        });
      } catch {
        // 網路未 idle 非致命，仍可繼續（evaluate 可能稍慢但可工作）
      }
      // ═══ Fix 2026-07-08 (v4): 頁面 readiness 重試驗證 ═══
      // 單次 ping 失敗率高（SPA V8 context 初始化未完成導致 Runtime.callFunctionOn timed out），
      // 改用 retry loop：最多 3 次，每次 3s timeout + 1s 間隔，總計 ≤12s。
      // 較原版單次 5s 提升覆蓋率，且不影響外層 25s 總逾時。
      let _ready = false;
      for (let _ri = 0; _ri < 3; _ri++) {
        try {
          await Promise.race([
            page.evaluate(() => document.readyState),
            new Promise((_, rej) =>
              setTimeout(
                () => rej(new Error(`page ping 逾時 (attempt ${_ri + 1})`)),
                3000,
              ),
            ),
          ]);
          _ready = true;
          break;
        } catch (_e) {
          if (_ri < 2) {
            logger.debug(
              `⏳ readiness ping attempt ${_ri + 1} 失敗，1s 後重試...`,
              "CHROME",
            );
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      if (!_ready) {
        logger.warn(
          `暫時頁面 readiness 檢查失敗 (${Date.now() - _t0}ms, 3 次嘗試)，放棄此頁面`,
          "CHROME",
        );
        try {
          if (!page.isClosed()) await page.close();
        } catch {}
        return null;
      }
      // ═══ Fix 2026-07-08: 批次累計，最後合併為一行 ═══
      // 不印單頁 log，改推入累加器，3s 靜默後一次性輸出 min/max/avg
      // 格式與健康報告一致（單行摘要）
      const _total = Date.now() - _t0;
      _pageTimings.push(_total);
      clearTimeout(_pageFlushTimer);
      _pageFlushTimer = setTimeout(_flushPageTimings, 3000);
      return page;
    } catch (e) {
      if (page) {
        try {
          if (!page.isClosed()) await page.close();
        } catch {}
      }
      logger.warn(
        `建立暫時頁面失敗 (${Date.now() - _t0}ms): ${e.message}`,
        "CHROME",
      );
      return null;
    }
  }

  async init() {
    // ═══ Fix 2026-07-20: Chrome 未安裝 → 一次性永久禁用，不再重試 ═══
    if (this._chromeNotFound) return;
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    ) {
      if (!this._chromeNotFoundWarned) {
        logger.warn(
          "[CHROME] ⛔ Chrome Fetch 已禁用，直接使用 Axios",
          "CHROME",
        );
        this._chromeNotFoundWarned = true;
      }
      this.ready = false;
      return;
    }
    if (this.ready) return;
    if (this._initLock) return this._initLock;

    // ═══ 斷路器檢查：連續失敗時採用指數退避 ═══
    if (!_cbShouldTry()) {
      if (!CB._warned) {
        const waitSec = Math.round(
          (CB.cooldown - (Date.now() - CB.lastAttempt)) / 1000,
        );
        logger.warn(
          `[CHROME] ⏳ 斷路器開啟，等待 ${waitSec}s 後再試（已連續失敗 ${CB.failures} 次）`,
        );
        CB._warned = true;
      }
      return;
    }

    this._initLock = this._doInit();
    try {
      await this._initLock;
      _cbRecordSuccess();
    } catch (e) {
      if (e.message === "Chrome 未安裝") {
        // Chrome 不存在 → 一次性永久禁用，禁止任何後續重試
        this._chromeNotFound = true;
        CB._permanentDisabled = true;
        CB._permanentWarned = true;
        process.env.CHROME_DISABLED = "true";
        process.env.DISABLE_BROWSER = "true";
        process.env.CHROME_NOT_FOUND = "true";
        logger.warn(
          "[CHROME] ⛔ Chrome 未安裝，永久禁用 Fetch Proxy（僅用 Axios）",
          "CHROME",
        );
        await this.destroy().catch(() => {});
        this.ready = false;
        this._initLock = null;
        return;
      }
      // ═══ 其他錯誤 → 斷路器計數 + 指數退避 ═══
      _cbRecordFail(true);
      logger.warn(
        `[CHROME] ⚠️ 初始化異常: ${e.message}，降級至 Axios（下次重試 ${Math.round(CB.cooldown / 1000)}s 後）`,
      );
      await this.destroy().catch(() => {});
      this.ready = false;
    }
    this._initLock = null;
  }

  async _doInit() {
    const chromePath = this.findChrome();
    const useBundled = !chromePath;
    if (useBundled) {
      logger.info("系統未找到 Chrome，使用 Puppeteer 自帶 Chromium", "CHROME");
    }

    const fs = require("fs");
    const path = require("path");
    const CHROME_DIR = path.join(__dirname, "../../.chrome-qwen-profile");
    if (!fs.existsSync(CHROME_DIR))
      fs.mkdirSync(CHROME_DIR, { recursive: true });
    // 清理殘留 Chrome 進程 + 鎖檔
    try {
      require("child_process").execSync(
        "killall -9 chrome google-chrome chromium 2>/dev/null || true",
        { stdio: "pipe" },
      );
    } catch {}
    this._cleanProfileLock(CHROME_DIR);

    this._initT0 = Date.now();
    logger.info("Chrome Fetch Proxy v3 初始化...", "CHROME");

    const UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
    const baseArgs = [
      `--user-data-dir=${CHROME_DIR}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=IsolateOrigins,site-per-process,Gcm,Translate",
      "--disable-popup-blocking",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
      "--disable-breakpad",
      "--noerrdialogs",
      "--enable-logging=stderr",
      "--v=0",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-ipc-flooding-protection",
      "--disable-prompt-on-repost",
      "--disable-software-rasterizer",

      "--mute-audio",
      "--window-size=1280,720",
      `--user-agent=${UA}`,
    ];

    const execSync = require("child_process").execSync;
    const launchChrome = async (tryCount) => {
      try {
        const launchOpts = {
          headless: true,
          args: baseArgs,
          defaultViewport: { width: 1280, height: 720 },
          timeout: 45000,
          protocolTimeout: 300000,
          dumpio: false,
        };
        // ═══ 系統無 Chrome → 用 Puppeteer 自帶 Chromium ═══
        if (!useBundled) launchOpts.executablePath = chromePath;
        return await puppeteer.launch(launchOpts);
      } catch (e) {
        // profile 被佔用 → 殺光 Chrome 進程 + 清鎖檔 + 重試一次
        if (tryCount < 1 && (e.message || "").includes("already running")) {
          logger.warn("Chrome profile 被佔用，強制清理後重試...", "CHROME");
          try {
            execSync(
              "killall -9 chrome google-chrome chromium chromium-browser 2>/dev/null || true",
              { stdio: "pipe" },
            );
          } catch {}
          this._cleanProfileLock(CHROME_DIR);
          await new Promise((r) => setTimeout(r, 1000));
          return launchChrome(1);
        }
        throw e;
      }
    };

    this.browser = await launchChrome(0);

    // ═══ Fix: 關閉預設 page，建立全新頁面（避免「Requesting main frame too early」）═══
    const existingPages = await this.browser.pages();
    for (const p of existingPages) {
      try {
        await p.close();
      } catch {}
    }
    // ═══ Fix: 保護 newPage() 失敗，重啟 browser（移除 --disable-gpu） ═══
    try {
      this.page = await this.browser.newPage();
    } catch (e) {
      if (
        (e.message || "").includes("Target.createTarget") ||
        (e.message || "").includes("new tab")
      ) {
        logger.warn(
          `browser.newPage() 失敗 (${e.message})，移除 disable-gpu 重試`,
          "CHROME",
        );
        await this.browser.close().catch(() => {});
        this.browser = null;
        const args2 = baseArgs.filter((a) => a !== "--disable-gpu");
        this.browser = await puppeteer.launch({
          executablePath: chromePath,
          headless: true,
          args: args2,
          defaultViewport: { width: 1280, height: 720 },
          timeout: 45000,
          protocolTimeout: 300000,
          dumpio: false,
        });
        this.page = await this.browser.newPage();
      } else {
        throw e;
      }
    }

    // 設定 token Cookie (使用 CDP Network.setCookie 繞過 page.setCookie 的 frame 依賴)
    const account = accountManager.getAccount();
    const token = account ? account.token : "";
    if (token) {
      try {
        // ═══ Fix 6: 先導航至 chat.qwen.ai 再設 Cookie，確保 CDP session 可用 ═══
        const navRes = await this.page.goto(this.chatBaseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // ═══ 檢查 WAF 阻擋：如果狀態碼是 403/503 或 body 含 WAF 關鍵字，跳過 Cookie 設定 ═══
        if (navRes && (navRes.status() === 403 || navRes.status() === 503)) {
          logger.warn(
            "[CHROME] WAF 阻擋頁面 (HTTP " +
              navRes.status() +
              ")，先嘗試繼續...",
            "CHROME",
          );
        } else {
          const cdp = await this.page.createCDPSession();
          await cdp.send("Network.setCookie", {
            name: "token",
            value: token,
            domain: ".chat.qwen.ai",
            path: "/",
            httpOnly: false,
            secure: true,
          });
        }
      } catch {
        // fallback: 正常導航後 Cookie 由 WAF 流程處理，此處非必要
      }
    } else {
      // 無 token 仍導航至 chat.qwen.ai
      try {
        await this.page.goto(this.chatBaseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } catch {}
    }

    // 設定 SSE 事件橋接
    await this.page.exposeFunction("__qwenFetchOnData", (reqId, data) => {
      const cb = this.callbacks.get(reqId);
      if (cb) cb.onData(data);
    });
    await this.page.exposeFunction("__qwenFetchOnDone", (reqId) => {
      const cb = this.callbacks.get(reqId);
      if (cb) {
        this.callbacks.delete(reqId);
        cb.onDone();
      }
    });
    await this.page.exposeFunction("__qwenFetchOnError", (reqId, err) => {
      const cb = this.callbacks.get(reqId);
      if (cb) {
        this.callbacks.delete(reqId);
        cb.onError(err);
      }
    });

    // 等待 WAF 挑戰完成
    try {
      await this.page.waitForFunction(
        () => {
          const t = document.title.toLowerCase();
          return (
            t.includes("qwen") ||
            t.includes("千问") ||
            t.includes("chat") ||
            t.includes("studio")
          );
        },
        { timeout: 20000 },
      );
      logger.success("🎉 WAF 挑戰通過！🎉 繞過阿里雲 WAF 成功！", "CHROME");
    } catch {
      logger.warn("WAF 等待超時 (20s)，仍嘗試繼續...", "CHROME");
    }

    // 注入通用 fetch 包裝函式 (供 page.evaluate 呼叫)
    await this.page.evaluate(() => {
      window.__qwenApiFetch = async function (url, opts) {
        const res = await fetch(url, opts);
        return {
          ok: res.ok,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.text(),
        };
      };
    });

    this.ready = true;
    // ═══ Fix 5: Chrome crash/disconnect 時徹底清理子程序 ═══
    this.browser.on("disconnected", () => {
      logger.warn("Chrome 瀏覽器連線中斷，標記為未就緒", "CHROME");
      // ═══ Fix 8: 銷毀所有 active streams，避免串流永久懸掛 ═══
      for (const [rid, cb] of this.callbacks) {
        clearTimeout(cb._tid);
        try {
          cb._stream?.destroy(new Error("Chrome 瀏覽器連線中斷"));
        } catch {}
      }
      this.callbacks.clear();
      try {
        if (this.browser && this.browser.process) {
          this.browser.process().kill("SIGKILL");
        }
      } catch (_) {}
      this.ready = false;
      this.page = null;
      this.browser = null;
    });
    const elapsed = Date.now() - this._initT0;
    logger.success(`Chrome Fetch 初始化完成 (${elapsed}ms)`, "CHROME");
  }

  /**
   * 建立新聊天 — 使用 Chrome 原生 fetch 繞過 WAF（含 JA3 TLS 指紋）
   * ═══ Fix 2026-07-07: 使用暫時頁面隔離 POST crash ═══
   * 原本用 this.page.evaluate()，但 POST fetch 導致 Chrome target 關閉
   * （Target closed），使 main page 無法再用於後續健康檢查與 GET 請求。
   * 改用 _freshInitPage() 建立暫時頁面，POST 即使 crash 也只影響暫時頁面，
   * main page 保持健康。
   *
   * @param {string} model - 上游模型名稱
   * @param {string} [token] - JWT token
   * @returns {Promise<string|null>} chat_id
   */
  async createChat(model, token) {
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    )
      return null;
    if (!token) {
      const account = accountManager.getAccount();
      token = account ? account.token : "";
    }
    if (!token) return null;

    await this.init();
    if (!this.ready || !this.browser) return null;

    // ═══ Fix: 使用暫時頁面（非 this.page）執行 POST fetch ═══
    const tempPage = await this._freshInitPage();
    if (!tempPage) {
      logger.warn("createChat: 無法建立暫時頁面", "CHROME");
      return null;
    }

    try {
      // ═══ Fix: page.evaluate 加入動態逾時，防止 POST 永久懸掛 ═══
      // _freshInitPage 耗時 20-25s（WAF + networkIdle + readiness），
      // 外層必須留足夠 buffer：50s（原 30s 太緊，evaluate 來不及完成）。
      const _createChatTimeout = 50000;
      const chatId = await Promise.race([
        tempPage.evaluate(
          async (baseUrl, model, token) => {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 15000);
            try {
              const res = await fetch(`${baseUrl}/api/v2/chats/new`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + token,
                  source: "web",
                  version: "0.3.12",
                },
                body: JSON.stringify({
                  title: "New Chat",
                  models: [model],
                  chat_mode: "normal",
                  chat_type: "t2t",
                  timestamp: Date.now(),
                }),
                signal: controller.signal,
              });
              clearTimeout(tid);
              if (!res.ok) {
                const txt = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${txt.substring(0, 200)}`);
              }
              const json = await res.json();
              return json?.data?.id || null;
            } catch (e) {
              clearTimeout(tid);
              throw e;
            }
          },
          this.chatBaseUrl,
          model,
          token,
        ),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`createChat evaluate 逾時 ${_createChatTimeout / 1000}s`)),
            _createChatTimeout,
          ),
        ),
      ]);

      return chatId;
    } catch (e) {
      logger.warn(
        `createChat 失敗 (${Date.now() - (this._initT0 || Date.now())}ms): ${e.message}（暫時頁面，不影響 main page）`,
        "CHROME",
      );
      // ═══ Fix 2026-07-08 (v8): 預熱失敗觸發 WAF 模式，加速後續降級 ═══
      // 暫時頁面 evaluate 逾時表示 Chrome 實例不健康，標記 WAF 模式縮短 timeout。
      _cbRecordFail(true);
      return null;
    } finally {
      await tempPage.close().catch(() => {});
    }
  }

  /**
   * 發送 SSE 串流聊天請求，透過 PassThrough stream 橋接
   * @param {object} payload - 完整請求 body (含 messages, model, chat_id 等)
   * @param {object} [account] - 帳號物件 (含 token)
   * @param {AbortSignal} [signal] - 可選外部中止訊號（來自 request.js Promise.race 逾時）
   * @returns {{ status: boolean, response: PassThrough|null, currentAccount: object|null }}
   */
  async sendChatRequest(payload, account, signal) {
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    )
      return { status: false, response: null };
    await this.init();
    if (!this.ready) return { status: false, response: null };

    const currentAccount = account || accountManager.getAccount();
    const token = currentAccount ? currentAccount.token : "";
    if (!token) {
      logger.error("Chrome Fetch: 無可用 token", "CHROME");
      return { status: false, response: null, currentAccount: null };
    }

    // ═══ Fix 1: WAF 模式提前退出（省 8-12s 暫時頁面建立時間） ═══
    // 斷路器 WAF 模式下 Chrome SSE 必定失敗（WAF 阻擋整個流量），
    // 跳過暫時頁面建立與 SSE evaluate，直接降級 axios，避免對話停滯。
    if (CB._wafMode) {
      logger.warn(
        "[CHROME] ⛔ WAF 模式啟用，跳過 Chrome SSE (end-to-end blocking)",
        "CHROME",
      );
      return { status: false, response: null, currentAccount };
    }

    // 先建立 chat (如果 payload 沒有 chat_id)
    let chatId = payload.chat_id;
    if (!chatId) {
      chatId = await this.createChat(payload.model, token);
      if (!chatId) {
        logger.error("Chrome Fetch: 建立 chat 失敗", "CHROME");
        return { status: false, response: null, currentAccount };
      }
    }

    // 建立 PassThrough 串流
    const stream = new PassThrough();
    // ═══ Fix 2026-07-08: 孤立 stream 的 'error' 事件無監聽器會 crash 行程 ═══
    // 背景：request.js 的 Promise.race 在 15s 放棄 chromeReq 後，sendChatRequest
    // 仍在背景執行。20s 逾時觸發 stream.destroy(err)，'error' 事件在 Bun 中非同步
    // 發射（processTicksAndRejections），此時無監聽器 → uncaught exception → crash。
    // 解法：確保所有 PassThrough 最少有一個 error listener，防止孤立 stream crash。
    stream.on("error", () => {});
    const reqId = ++this.reqSeq;

    this.callbacks.set(reqId, {
      _stream: stream,
      _tid: null,
      onData: (chunk) => {
        try {
          stream.write(Buffer.from(chunk));
        } catch {}
      },
      onDone: () => {
        try {
          stream.end(null);
        } catch {}
      },
      onError: (errMsg) => {
        try {
          stream.destroy(new Error(errMsg));
        } catch {}
      },
    });

    // 設定超時清理
    const timeoutId = setTimeout(() => {
      const cb = this.callbacks.get(reqId);
      if (cb) {
        this.callbacks.delete(reqId);
        try {
          stream.destroy(new Error("Chrome Fetch 超時 (60s)"));
        } catch {}
      }
    }, 60000);
    this.callbacks.get(reqId)._tid = timeoutId;

    // ═══ Fix 2026-07-08 (v2): 外部中止訊號處理（request.js Promise.race 逾時時清理） ═══
    // 當 request.js 的 15s/25s 逾時勝出時，AbortController 觸發此 listener，
    // 立即清理 callbacks entry、清除內部 timeout、destroy stream，避免孤立 stream
    // 在背景完成後觸發無 listener 的 'error' 事件導致 crash。
    // ═══ Fix 33: abort 時同步計入斷路器（啟動 _wafMode 縮短後續 Chrome timeout ═══
    // request.js 已計 _consecWafBlocks++，但 chrome-fetch 的 CB._consecWafBlocks 未跟進
    // → _wafMode 永遠 false → Chrome timeout 維持 15s。此處補上讓三處 _cbRecordFail(true) 完整。
    if (signal) {
      const onAbort = () => {
        // 先計斷路器再清理（cb record 需在 callback 被刪除前）
        _cbRecordFail(true);
        const cb = this.callbacks.get(reqId);
        if (cb) {
          this.callbacks.delete(reqId);
          clearTimeout(cb._tid);
          try {
            stream.destroy(signal.reason || new Error("aborted"));
          } catch {}
        }
      };
      // 若 signal 已是 aborted 狀態（極罕見但防禦性處理）
      if (signal.aborted) {
        onAbort();
        return { status: false, response: null, currentAccount };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // 在回呼中清除 timeout
    const origOnDone = this.callbacks.get(reqId).onDone;
    this.callbacks.get(reqId).onDone = () => {
      clearTimeout(timeoutId);
      origOnDone();
    };
    const origOnError = this.callbacks.get(reqId).onError;
    this.callbacks.get(reqId).onError = (err) => {
      clearTimeout(timeoutId);
      origOnError(err);
    };

    // 建構上游請求 payload (沿用 middleware 處理好的格式)
    const upstreamPayload = {
      stream: true,
      version: payload.version || "2.1",
      incremental_output: payload.incremental_output !== false,
      chat_id: chatId,
      chat_mode: payload.chat_mode || "normal",
      model: payload.model,
      parent_id: payload.parent_id || null,
      messages: payload.messages || [],
      timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
      ...(payload.chat_type ? { chat_type: payload.chat_type } : {}),
    };

    // ═══ Fix 2026-07-07: 使用暫時頁面執行 SSE（隔離 main page） ═══
    // 原本用 this.page.evaluate()，POST 請求會導致 Chrome target 關閉，
    // 使得 main page 死亡影響後續 GET/健康檢查。
    // 改用 _freshInitPage() 建立專用 SSE 頁面，crash 時不影響 main page。
    // SSE 頁面在串流結束或錯誤時自動關閉（透過 onDone/onError 包裝）。
    const _runSseOnPage = async (targetPage) => {
      // 在目標頁面註冊 exposeFunction 橋接
      try {
        await targetPage.exposeFunction("__qwenFetchOnData", (id, data) => {
          const cb = this.callbacks.get(id);
          if (cb) cb.onData(data);
        });
        await targetPage.exposeFunction("__qwenFetchOnDone", (id) => {
          const cb = this.callbacks.get(id);
          if (cb) {
            this.callbacks.delete(id);
            cb.onDone();
          }
        });
        await targetPage.exposeFunction("__qwenFetchOnError", (id, err) => {
          const cb = this.callbacks.get(id);
          if (cb) {
            this.callbacks.delete(id);
            cb.onError(err);
          }
        });
      } catch {
        // exposeFunction 失敗（page 已關閉等），跳過
        return false;
      }

      // 包裝 callbacks 以在完成時關閉 SSE 頁面
      const _closeSsePage = () => {
        try {
          if (!targetPage.isClosed()) targetPage.close();
        } catch {}
      };
      const origOnDone = this.callbacks.get(reqId).onDone;
      this.callbacks.get(reqId).onDone = () => {
        clearTimeout(timeoutId);
        origOnDone();
        _closeSsePage();
      };
      const origOnError = this.callbacks.get(reqId).onError;
      this.callbacks.get(reqId).onError = (err) => {
        clearTimeout(timeoutId);
        origOnError(err);
        _closeSsePage();
      };

      // ═══ Fix 2026-07-08 (v3): page.evaluate 加 20s 硬性逾時 ═══
      // Runtime.callFunctionOn timed out 時 evaluate 會懸掛到 protocolTimeout (5min)，
      // 導致外層 15s 逾時已觸發但 evaluate 仍在背景執行，浪費資源。
      const _sseEvaluate = targetPage.evaluate(
        async (reqId, baseUrl, chatId, payload, token) => {
          try {
            const res = await fetch(
              `${baseUrl}/api/v2/chat/completions?chat_id=${chatId}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + token,
                  source: "web",
                  version: "0.3.12",
                  Accept: "text/event-stream",
                },
                body: JSON.stringify(payload),
              },
            );

            if (!res.ok) {
              const text = await res.text();
              window.__qwenFetchOnError(
                reqId,
                `HTTP ${res.status}: ${text.substring(0, 200)}`,
              );
              return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              if (chunk) window.__qwenFetchOnData(reqId, chunk);
            }

            window.__qwenFetchOnDone(reqId);
          } catch (e) {
            window.__qwenFetchOnError(reqId, e.message);
          }
        },
        reqId,
        this.chatBaseUrl,
        chatId,
        upstreamPayload,
        token,
      );
      // ═══ Fix 2026-07-08 (v3): 抑制 orphaned evaluate（timeout 勝出後 page 被關閉導致 rejection） ═══
      _sseEvaluate.catch(() => {});
      await Promise.race([
        _sseEvaluate,
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("Chrome SSE evaluate 逾時 30s")),
            30000,
          ),
        ),
      ]).catch((e) => {
        logger.error(`Chrome SSE page.evaluate 失敗: ${e.message}`, "CHROME");
        const cb = this.callbacks.get(reqId);
        if (cb) {
          this.callbacks.delete(reqId);
          clearTimeout(timeoutId);
          try {
            stream.destroy(new Error(`Chrome SSE evaluate 失敗: ${e.message}`));
          } catch {}
        }
        _closeSsePage();
        // ═══ Fix 2026-07-08: 重新拋出，讓 sendChatRequest 的 catch 可以處理降級 ═══
        throw e;
      });

      // 正常完成（未逾時）
      return;
    };

    // ═══ Fix 2026-07-08: 重構 SSE 頁面降級邏輯 — 正確處理成功/失敗 ═══
    // 原本 _runSseOnPage 的 catch 吸收所有錯誤但回傳 true，導致已毀 stream 被當成成功回傳。
    // 現在：temp page success → 直接回傳；失敗 → 降級 main page；main page 也失敗 → status:false。
    let sseSuccess = false;
    const ssePage = await this._freshInitPage();
    if (ssePage) {
      try {
        await _runSseOnPage(ssePage);
        sseSuccess = true;
      } catch {
        logger.warn("暫時頁面 SSE 失敗，嘗試降級至 main page", "CHROME");
      }
    }
    if (sseSuccess) {
      return { status: true, response: stream, currentAccount };
    }
    // ═══ Fix 33: WAF/abort 模式跳過 SSE 降級重試（省 20s main page evaluate） ═══
    // signal.aborted → request.js 已逾時，已計 _consecWafBlocks++，無須再等 20s
    // CB._wafMode → WAF 擋死中，20s 後結果一樣，直接跳過省時
    if (signal?.aborted || CB._wafMode) {
      const reason = signal?.aborted ? "request.js 已逾時" : "WAF 模式";
      logger.warn(
        `SSE 降級略過（${reason}，省 20s main page evaluate）`,
        "CHROME",
      );
      this.callbacks.delete(reqId);
      clearTimeout(timeoutId);
      try {
        stream.destroy(new Error("SSE 降級略過"));
      } catch {}
      return { status: false, response: null, currentAccount };
    }
    // 降級路徑：使用 main page 執行 SSE（若仍存活）
    if (this.page && this.ready) {
      logger.warn("降級至 main page 執行 SSE", "CHROME");
      let mainOk = false;
      // ═══ Fix 2026-07-08 (v3): main page evaluate 也加 20s 逾時 ═══
      const _mainEvaluate = this.page.evaluate(
        async (reqId, baseUrl, chatId, payload, token) => {
          try {
            const res = await fetch(
              `${baseUrl}/api/v2/chat/completions?chat_id=${chatId}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + token,
                  source: "web",
                  version: "0.3.12",
                  Accept: "text/event-stream",
                },
                body: JSON.stringify(payload),
              },
            );

            if (!res.ok) {
              const text = await res.text();
              window.__qwenFetchOnError(
                reqId,
                `HTTP ${res.status}: ${text.substring(0, 200)}`,
              );
              return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              if (chunk) window.__qwenFetchOnData(reqId, chunk);
            }

            window.__qwenFetchOnDone(reqId);
          } catch (e) {
            window.__qwenFetchOnError(reqId, e.message);
          }
        },
        reqId,
        this.chatBaseUrl,
        chatId,
        upstreamPayload,
        token,
      );
      // ═══ Fix 2026-07-08 (v3): 抑制 orphaned evaluate（同 temp page 策略） ═══
      _mainEvaluate.catch(() => {});
      try {
        await Promise.race([
          _mainEvaluate,
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("Chrome (main) evaluate 逾時 30s")),
              30000,
            ),
          ),
        ]);
        mainOk = true;
      } catch (e) {
        logger.error(
          `Chrome (main) page.evaluate 失敗: ${e.message}`,
          "CHROME",
        );
      }
      if (!mainOk) {
        const cb = this.callbacks.get(reqId);
        if (cb) {
          this.callbacks.delete(reqId);
          clearTimeout(timeoutId);
          try {
            stream.destroy(new Error(`Chrome evaluate 失敗: ${e.message}`));
          } catch {}
        }
      } else {
        // 正常完成
        return { status: true, response: stream, currentAccount };
      }
    }
    // main page 不可用或失敗 → 記錄斷路器 + 回傳失敗
    // ═══ Fix 2026-07-08: sendChatRequest 運行時失敗也計入斷路器 ═══
    // 原本僅 init() 失敗會觸發斷路器，但 sendChatRequest 的 page.evaluate 逾時
    // 不會累計到 CB.failures，導致每請求都重複嘗試 20s+20s=40s Chrome 才降級 axios。
    // 加入 _cbRecordFail() 後，持續的運行時失敗會加速斷路器冷卻，更快切換至 axios。
    // ═══ Fix 33: 防雙重計數 — signal.aborted 時 request.js 已計 _consecWafBlocks++ ═══
    // 此路徑只會在 signal 未中止且 WAF 模式未啟用時到達（Fix 2 已攔截 aborted + wafMode）。
    // 傳遞 isWaf=true 加速 _wafMode 啟動，縮短後續 Chrome timeout + 跳過 SSE retry。
    if (!signal?.aborted) _cbRecordFail(true);
    logger.error("Chrome 無可用頁面執行 SSE", "CHROME");
    this.callbacks.delete(reqId);
    clearTimeout(timeoutId);
    try {
      stream.destroy(new Error("Chrome 無可用頁面"));
    } catch {}
    return { status: false, response: null, currentAccount };
  }

  /**
   * 一般 HTTP 請求 (非串流, 用於 getLatestModels 等)
   * @param {string} url - 完整 URL
   * @param {object} [opts] - { method, headers, body }
   * @returns {Promise<{ok:boolean, status:number, body:string}>}
   */
  async fetch(url, opts = {}) {
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    )
      return { ok: false, status: 0, body: "" };
    await this.init();

    const result = await this.page.evaluate(
      async (url, opts) => {
        // 內部 fetch 設定 12s timeout，避免模型列表請求永久掛起
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const res = await fetch(url, {
            method: opts.method || "GET",
            headers: opts.headers || {},
            body: opts.body || undefined,
            signal: controller.signal,
          });
          clearTimeout(timer);
          return {
            ok: res.ok,
            status: res.status,
            body: await res.text(),
          };
        } catch (e) {
          clearTimeout(timer);
          return { ok: false, status: 0, body: e.message };
        }
      },
      url,
      opts,
    );

    return result;
  }

  /**
   * 取得目前頁面 cookies
   */
  async getCookies() {
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    )
      return [];
    await this.init();
    return this.page.cookies();
  }

  /**
   * 健康檢查
   * 驗證 Chrome 頁面是否仍可正常執行 JS，且非 WAF/錯誤頁面
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    if (
      process.env.DISABLE_BROWSER === "true" ||
      process.env.CHROME_DISABLED === "true"
    )
      return false;
    try {
      if (!this.ready || !this.browser || !this.page) return false;
      if (!this.browser.isConnected()) {
        this.ready = false;
        return false;
      }
      const result = await this.page.evaluate(() => {
        try {
          const title = (document.title || "").toLowerCase();
          const body = (document.body?.innerText || "").toLowerCase();
          // WAF/錯誤頁面偵測
          if (
            body.includes("waf") ||
            body.includes("blocked") ||
            body.includes("captcha") ||
            body.includes("verify") ||
            body.includes("安全驗證") ||
            body.includes("請確認你不是機器人")
          ) {
            return false;
          }
          return title.length > 0;
        } catch {
          return false;
        }
      });
      return !!result;
    } catch {
      this.ready = false;
      return false;
    }
  }

  /**
   * 自動恢復（含指數退避）
   * 重新啟動 Chrome 並通過 WAF
   */
  async recover() {
    // 斷路器檢查
    if (!_cbShouldTry()) {
      if (!CB._warned) {
        const waitSec = Math.round(
          (CB.cooldown - (Date.now() - CB.lastAttempt)) / 1000,
        );
        logger.warn(
          `[CHROME] ⏳ 恢復跳過：斷路器開啟，等待 ${waitSec}s（已連續失敗 ${CB.failures} 次）`,
        );
        CB._warned = true;
      }
      return false;
    }

    logger.warn("Chrome Fetch 正在自動恢復...", "CHROME");
    try {
      await this.destroy();
    } catch {}
    this._initLock = null;
    initPromise = null;
    try {
      await this.init();
      if (this.ready) {
        _cbRecordSuccess();
        logger.success("Chrome Fetch 自動恢復成功", "CHROME");
        return true;
      }
      // init() 返回了但 browser 未就緒（_doInit 失敗被 init 內部吞掉）
      _cbRecordFail();
      logger.error(
        `Chrome Fetch 自動恢復失敗: browser 未就緒（下次 ${Math.round(CB.cooldown / 1000)}s 後重試）`,
        "CHROME",
      );
      return false;
    } catch (e) {
      _cbRecordFail();
      logger.error(
        `Chrome Fetch 自動恢復失敗: ${e.message}（下次 ${Math.round(CB.cooldown / 1000)}s 後重試）`,
        "CHROME",
      );
      return false;
    }
  }

  /**
   * 清理資源
   * ═══ Fix 2026-07-06: SIGTERM 優先 → 等待 3s → SIGKILL 最後手段 + profile 清理 ═══
   */
  async destroy() {
    this.ready = false;
    this.callbacks.clear();
    if (this.browser) {
      const proc = this.browser.process();
      try {
        // 先 SIGTERM 讓 Chrome 優雅關閉（避免 profile 損毀）
        if (proc) proc.kill("SIGTERM");
        await this.browser.close();
      } catch (_) {}
      // 等 3s 讓 Chrome 完全關閉
      await new Promise((r) => setTimeout(r, 3000));
      // 若進程仍存活，強制 SIGKILL
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch (_) {}
      }
      this.browser = null;
      this.page = null;
      // 清理 profile 鎖檔，確保下次啟動不卡
      const fs = require("fs");
      const path = require("path");
      const CHROME_DIR = path.join(__dirname, "../../.chrome-qwen-profile");
      this._cleanProfileLock(CHROME_DIR);
    }
    instance = null;
    logger.info("Chrome Fetch Proxy 已關閉", "CHROME");
  }
}

function getInstance() {
  if (!instance) instance = new ChromeFetch();
  return instance;
}

// ═══ Fix 2026-07-08 (v5): 斷路器狀態匯出 — 供 request.js 判斷是否縮短 Chrome 逾時 ═══
// 回傳：
//   { wafMode, consecWafBlocks, permanentDisabled, failures }
//   wafMode = Chrome 判斷目前處於 WAF 阻擋模式
//   consecWafBlocks = 連續 WAF 阻擋次數
//   permanentDisabled = Chrome Fetch 是否被永久禁用
//   failures = 目前連續失敗次數
function getCircuitBreakerState() {
  return {
    wafMode: CB._wafMode,
    consecWafBlocks: CB._consecWafBlocks,
    permanentDisabled: CB._permanentDisabled,
    failures: CB.failures,
  };
}

module.exports = { ChromeFetch, getInstance, getCircuitBreakerState };
