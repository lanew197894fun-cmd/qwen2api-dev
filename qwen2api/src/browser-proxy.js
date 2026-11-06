#!/usr/bin/env bun
/**
 * browser-proxy.js — Chrome 自動化 WAF 繞過代理 + Token 自動續約
 *
 * 功能：
 *   1. HTTP 代理埠 3457 — 用瀏覽器 cookies 轉發請求繞過 WAF
 *   2. 自動續約 Token — 定時從 Chrome localStorage 提取 token 寫入 data.json
 *   3. Chrome 崩潰自動重啟 + Watchdog
 *
 * 原理：
 *   WAF JS challenge 只有真實瀏覽器能解。啟動 Chrome headless 維持 chat.qwen.ai
 *   頁面，定期萃取 cookies 用於 API 請求轉發，繞過阿里雲 WAF。
 *   同時從 localStorage 讀取 token 寫入 data.json，實現自動續約。
 *
 * 管理面板（已有，非本服務提供）：http://127.0.0.1:8317/management.html
 *
 * 用法：
 *   bun src/browser-proxy.js               # 前景執行
 *   bun src/browser-proxy.js --daemon      # 背景執行
 *
 * 設定 QWEN_CHAT_PROXY_URL=http://127.0.0.1:3457 即可啟用代理
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
const _req = createRequire(import.meta.filename);
const { encrypt } = _req("./utils/encryption");
const puppeteer = _req("puppeteer-core");
import {
  discoverSelectors,
  createNewChat,
  sendAndMonitor,
} from "./browser-rpa.mjs";

// ── 回應安全寫入（write after end 是非同步 error 事件，try/catch 攔不住）──
const _safeResWrite = (res, data) => {
  try {
    if (!res.destroyed && !res.writableEnded) {
      res.write(data);
      return true;
    }
  } catch {}
  return false;
};

// ── 設定 ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.BROWSER_PROXY_PORT || "3457", 10);
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  // 系統級 Chrome 路徑掃描（跨裝置通用）
  const candidates = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  // fallback: 嘗試 PATH 偵測（同步，無 await）
  try {
    const p = execSync(
      "which google-chrome chromium chrome 2>/dev/null || echo ''",
      { encoding: "utf8", timeout: 3000 },
    )
      .trim()
      .split("\n")[0];
    if (p) return p;
  } catch {}
  return "/usr/bin/google-chrome";
}
const CHROME_PATH = findChrome();
const PROFILE_DIR =
  process.env.CHROME_PROFILE_DIR ||
  path.resolve(import.meta.dirname, "..", ".chrome-qwen-profile");
const DATA_FILE =
  process.env.DATA_FILE ||
  path.resolve(import.meta.dirname, "..", "data", "data.json");
const TARGET_URL = process.env.BROWSER_PROXY_TARGET || "https://chat.qwen.ai";
const COOKIE_REFRESH_MS = parseInt(
  process.env.COOKIE_REFRESH_INTERVAL || "300000",
  10,
); // 5 min
const TOKEN_REFRESH_MS = parseInt(
  process.env.TOKEN_REFRESH_INTERVAL || "3600000",
  10,
); // 1 hr
const WATCHDOG_MS = 15000;
const PID_FILE = path.resolve(import.meta.dirname, "..", ".browser-proxy.pid");
const LOG_DIR = path.resolve(import.meta.dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "browser-proxy.log");

// ── Logger ────────────────────────────────────────────────────────
const LOG_LEVEL = ((raw) => {
  const m = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  return m[raw] !== undefined ? m[raw] : 3;
})(process.env.BROWSER_PROXY_LOG_LEVEL);
let _logFd = null;

function logInit() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _logFd = fs.openSync(LOG_FILE, "a");
  } catch {}
}

function log(level, ...args) {
  const lv = { E: 1, W: 2, I: 3, D: 4 }[level] || 3;
  if (lv > LOG_LEVEL) return;
  const ts = new Date().toISOString().slice(11, 23);
  const msg = `[${ts}] [${level}] [bp] ${args.join(" ")}`;
  // Colors handled by start.js's colorize() based on [E]/[W]/[I]/[D] keyword
  // Use console.error for E, console.warn for W to keep proper stream semantics
  // start.js wraps ALL output with ANSI colors regardless of source stream
  if (level === "E") console.error(msg);
  else if (level === "W") console.warn(msg);
  else console.log(msg);
  if (_logFd !== null) {
    try {
      fs.writeSync(_logFd, msg + "\n");
    } catch {}
  }
}

// ── 工具函數 ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { accounts: [] };
  }
}

function writeData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// ── RPA mutex queue ────────────────────────────────────────────
// browser-proxy 只有一個 page，RPA 操作必須序列化
// 一次只處理一個 /ui/chat/send 請求，其餘排隊等候

let rpaMutex = Promise.resolve();
let rpaQueueLen = 0;

async function withRPAMutex(fn, signal) {
  rpaQueueLen++;
  const prev = rpaMutex;
  let release;
  rpaMutex = new Promise((r) => {
    release = r;
  });
  try {
    await prev;
    if (signal?.aborted) throw new Error("canceled_while_queued");
    return await fn();
  } finally {
    rpaQueueLen = Math.max(0, rpaQueueLen - 1);
    if (release) release();
  }
}

// ── Chrome 生命週期（使用 Puppeteer launch） ─────────────────────
let browser = null,
  page = null, // 主頁面（SPA，qwen.ai 登入狀態管理）
  proxyPage = null, // 隱藏頁面（about:blank，專用於 API 代理 fetch）
  browserProc = null;
let cookies = "",
  userAgent = "",
  lastCookieRefresh = 0;
let pageReady = false,
  shuttingDown = false;

function browserAlive() {
  return browser && typeof browser === "object" && browser.connected;
}

async function launchChrome() {
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
    page = null;
  }
  if (browserProc) {
    try {
      browserProc.kill("SIGKILL");
    } catch {}
    browserProc = null;
  }

  log("I", `啟動 Chrome: ${CHROME_PATH} (headless=new, stealth)`);
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true, // Puppeteer v25 new headless
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      // P39: 降低 Chrome 記憶體用量，減少 OOM 機率
      "--memory-pressure-off",
      "--max_old_space_size=512",
      "--disable-features=TranslateUI",
      "--disable-features=OptimizationHints",
      "--disable-features=MediaRouter",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-field-trial-config",
    ],
  });
  log("I", `Chrome 已啟動: ${await browser.version()}`);

  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());

  // ── Stealth: 覆寫 automation 指紋 ──
  await page.evaluateOnNewDocument(() => {
    // 1. 移除 webdriver 屬性
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
      configurable: true,
    });
    // 2. 覆寫 userAgent（移除 Headless 字樣）
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      configurable: true,
    });
    // 3. 覆寫 plugins 陣列（實際有值即可）
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
    // 4. 覆寫 languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-CN", "zh", "en"],
      configurable: true,
    });
    // 5. 覆寫 chrome.runtime (沒這個會被 detect)
    if (!window.chrome?.runtime) {
      try {
        const fakeRt = {};
        window.chrome = window.chrome || {};
        window.chrome.runtime = fakeRt;
      } catch {}
    }
    // 6. 覆寫 WebGL vendor (避免透過 GPU 指紋偵測)
    try {
      const getExt = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...a) {
        const ctx = getExt.apply(this, a);
        if (ctx && ctx.getParameter) {
          const origGetP = ctx.getParameter.bind(ctx);
          ctx.getParameter = function (p) {
            if (p === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
            return origGetP(p);
          };
        }
        return ctx;
      };
    } catch {}
  });

  page.on("error", () => {
    pageReady = false;
  });
  page.on("pageerror", (e) => log("W", `頁面錯誤: ${e.message}`));

  try {
    await page.goto(TARGET_URL, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
  } catch (e) {
    log("W", `首次導航: ${e.message}`);
  }
  await extractCookies();

  // 建立第二頁面（同 profile，共享 cookies）專門用於 API 代理 fetch
  // 主頁面 SPA 導航時會銷毀 page.evaluate() context
  // 用第二頁面隔離，不受主頁面導航影響
  try {
    proxyPage = await browser.newPage();
    await proxyPage.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    // 等待幾秒讓 SPA hydration 完成，確保 proxyPage 穩定
    await sleep(2000);
    log("I", `proxy 頁面就緒 (${TARGET_URL}, 共享 cookies)`);
  } catch (e) {
    log("W", `建立 proxy 頁面失敗: ${e.message}，降級使用主頁面`);
    proxyPage = page;
  }

  // P46: 增加 Puppeteer 預設 protocol timeout，避免 WAF 挑戰期間 evaluate 超時
  page.setDefaultTimeout(120000);
  if (proxyPage && proxyPage !== page) proxyPage.setDefaultTimeout(120000);

  pageReady = true;
  log("I", `頁面就緒 cookies=${cookies.length}chars`);
}

async function startBrowser() {
  try {
    await launchChrome();
  } catch (e) {
    log("E", `啟動失敗: ${e.message}`);
    if (!shuttingDown) setTimeout(() => startBrowser().catch(() => {}), 10000);
  }
}

async function extractCookies() {
  if (!page || page.isClosed()) return false;
  try {
    const ck = await page.cookies();
    const ckStr = ck.map((c) => `${c.name}=${c.value}`).join("; ");
    if (ckStr) cookies = ckStr;
    userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
    lastCookieRefresh = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function refreshSession() {
  if (!page || page.isClosed() || !browserAlive()) {
    pageReady = false;
    return;
  }
  try {
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await sleep(3000);
    await extractCookies();
  } catch {
    await extractCookies();
  }
}

// ── Token 自動續約（從 Chrome localStorage 提取 token 寫入 data.json） ──
async function refreshToken() {
  if (!page || page.isClosed() || !browserAlive()) {
    log("W", "頁面不可用，跳過 token 續約");
    return null;
  }
  try {
    const token = await page.evaluate(() => localStorage.getItem("token"));
    if (!token || !token.startsWith("eyJ")) {
      log("D", "localStorage 中無有效 token");
      return null;
    }
    const decoded = decodeJwt(token);
    const expires = decoded?.exp || nowUnix() + 86400 * 7;

    const data = readData();
    if (!data.accounts?.length) {
      log("W", "data.json 無帳號，跳過續約");
      return null;
    }

    for (const acct of data.accounts) {
      if (acct.refresh_method !== "browser") continue;
      acct.token = encrypt(token);
      acct.expires = expires;
      acct.last_refreshed = new Date().toISOString();
      log(
        "I",
        `Token 續約: ${acct.email || "unknown"} 到期: ${new Date(expires * 1000).toISOString()}`,
      );
    }
    writeData(data);
    return token;
  } catch (e) {
    log("E", `Token 續約失敗: ${e.message}`);
    return null;
  }
}

// ── UI 自動化路由（RPA 模式：操作真實 SPA UI 繞過 WAF） ──
// WAF JS challenge 需要真實瀏覽器執行。與其用 page.evaluate(fetch) 繞過，
// 不如直接操作 SPA UI（點擊「新對話」、輸入訊息、Enter），讓瀏覽器自然處理 WAF。

const sendJSON = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

// ── qwen.ai 登入幫助頁面 HTML ──
const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qwen.ai 登入管理</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0f172a; color:#e2e8f0; padding:20px; max-width:800px; margin:0 auto; }
  h1 { font-size:1.5rem; margin-bottom:8px; display:flex; align-items:center; gap:8px; }
  .desc { color:#94a3b8; font-size:0.9rem; margin-bottom:20px; line-height:1.5; }
  .card { background:#1e293b; border-radius:12px; padding:20px; margin-bottom:16px; border:1px solid #334155; }
  .card h2 { font-size:1rem; margin-bottom:12px; display:flex; align-items:center; gap:6px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; align-items:center; }
  button { padding:10px 20px; border:none; border-radius:8px; font-size:0.9rem; cursor:pointer; font-weight:600; transition:all 0.15s; }
  button:active { transform:scale(0.97); }
  .btn-primary { background:#3b82f6; color:#fff; }
  .btn-primary:hover { background:#2563eb; }
  .btn-success { background:#22c55e; color:#fff; }
  .btn-success:hover { background:#16a34a; }
  .btn-warn { background:#f59e0b; color:#1e293b; }
  .btn-warn:hover { background:#d97706; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  .badge { display:inline-block; padding:4px 10px; border-radius:20px; font-size:0.8rem; font-weight:600; }
  .badge-ok { background:#22c55e30; color:#22c55e; border:1px solid #22c55e60; }
  .badge-err { background:#ef444430; color:#ef4444; border:1px solid #ef444460; }
  .badge-warn { background:#f59e0b30; color:#f59e0b; border:1px solid #f59e0b60; }
  pre { background:#0f172a; padding:12px; border-radius:8px; font-size:0.8rem; overflow-x:auto; margin:8px 0; max-height:200px; }
  textarea { width:100%; background:#0f172a; border:1px solid #334155; border-radius:8px; padding:10px; color:#e2e8f0; font-family:monospace; font-size:0.8rem; min-height:100px; }
  label { font-size:0.85rem; color:#94a3b8; display:block; margin-bottom:4px; }
  #status { font-size:0.85rem; padding:8px; border-radius:6px; margin-top:8px; }
  .status-ok { background:#22c55e20; border:1px solid #22c55e40; color:#22c55e; }
  .status-err { background:#ef444420; border:1px solid #ef444440; color:#ef4444; }
  .status-info { background:#3b82f620; border:1px solid #3b82f640; color:#3b82f6; }
  .mt-4 { margin-top:16px; }
  .flex { display:flex; align-items:center; gap:8px; }
</style>
</head>
<body>
<h1>🔐 qwen.ai 登入管理</h1>
<div class="desc">
  管理 headless Chrome 瀏覽器的 qwen.ai 登入狀態。
  請先從您的瀏覽器登入 qwen.ai，然後將 cookies 匯入到此處。
</div>

<div class="card">
  <h2>📊 目前狀態</h2>
  <div id="statusDisplay" class="status-info">載入中...</div>
  <div class="row">
    <button class="btn-primary" onclick="checkStatus()">🔄 檢查登入狀態</button>
    <button class="btn-success" onclick="navigateToQwen()">🚀 導航到 qwen.ai</button>
    <button class="btn-warn" onclick="navigateToLogin()">🔑 前往登入頁</button>
  </div>
</div>

<div class="card">
  <h2>🍪 匯入 Cookies</h2>
  <div class="desc">
    從你已登入 qwen.ai 的瀏覽器匯出 cookies（JSON 格式），貼到下方後按「注入 Cookies」。
    可用 EditThisCookie 擴充功能或 Chrome DevTools → Application → Cookies → Export。
  </div>
  <label>Cookies JSON 陣列（[{name, value, domain, ...}]）：</label>
  <textarea id="cookiesInput" placeholder='[{"name":"token","value":"xxx","domain":".qwen.ai"}]'></textarea>
  <div class="row">
    <button class="btn-primary" onclick="injectCookies()">📥 注入 Cookies</button>
    <button class="btn-success" onclick="saveSession()">💾 儲存 Session</button>
  </div>
</div>

<div class="card">
  <h2>📋 從 EditThisCookie 匯出教學</h2>
  <ol style="color:#94a3b8; font-size:0.85rem; line-height:1.6; padding-left:20px;">
    <li>在已登入 qwen.ai 的瀏覽器安裝 <a href="https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg" target="_blank" style="color:#60a5fa;">EditThisCookie</a></li>
    <li>打開 <code style="background:#334155; padding:2px 6px; border-radius:4px;">https://chat.qwen.ai</code></li>
    <li>點 EditThisCookie 圖示 → Export (JSON)</li>
    <li>複製全部內容，貼到上方 textarea</li>
    <li>按「注入 Cookies」</li>
  </ol>
</div>

<script>
// ── 檢查狀態 ──
async function checkStatus() {
  const btn = event?.target; if(btn) btn.disabled = true;
  const el = document.getElementById('statusDisplay');
  el.className = 'status-info'; el.textContent = '檢查中...';
  try {
    const r = await fetch('/ui/status');
    const d = await r.json();
    if (d.hasToken && d.url && !d.url.includes('login')) {
      el.className = 'status-ok';
      el.innerHTML = \`✅ <b>已登入</b> — URL: \${d.url} | Cookies: \${d.cookieCount} 個 | Token: 有\n🟢 瀏覽器就緒: \${d.pageReady} | Chrome: \${d.chromeAlive ? '✅' : '❌'}\`;
    } else if (d.url && d.url.includes('login')) {
      el.className = 'status-err';
      el.innerHTML = \`❌ <b>未登入</b> — 目前頁面: \${d.title} | 請貼入 cookies 或手動登入\n📋 URL: \${d.url}\`;
    } else {
      el.className = 'status-warn';
      el.innerHTML = \`⚠️ <b>部分登入</b> — Token: \${d.hasToken ? '有✅' : '無❌'} | Cookies: \${d.cookieCount} 個\n📋 URL: \${d.url} | Title: \${d.title}\`;
    }
  } catch(e) {
    el.className = 'status-err';
    el.textContent = '❌ 連線失敗: ' + e.message;
  }
  if(btn) btn.disabled = false;
}

// ── 導航到 qwen.ai ──
async function navigateToQwen() {
  const btn = event?.target; if(btn) { btn.disabled = true; btn.textContent = '導航中...'; }
  try {
    const r = await fetch('/ui/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:'https://chat.qwen.ai/'}) });
    const d = await r.json();
    if(d.isLoggedIn) {
      document.getElementById('statusDisplay').className = 'status-ok';
      document.getElementById('statusDisplay').innerHTML = '✅ 已登入，無須操作';
    } else {
      document.getElementById('statusDisplay').className = 'status-warn';
      document.getElementById('statusDisplay').innerHTML = '🔑 已導航到登入頁，但 headless 瀏覽器無法互動。<br>請改用「匯入 Cookies」方式登入。';
    }
  } catch(e) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ 導航失敗: ' + e.message;
  }
  if(btn) { btn.disabled = false; btn.textContent = '🚀 導航到 qwen.ai'; }
}

// ── 前往登入頁 ──
async function navigateToLogin() {
  const btn = event?.target; if(btn) { btn.disabled = true; btn.textContent = '導航中...'; }
  try {
    const r = await fetch('/ui/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({}) });
    const d = await r.json();
    document.getElementById('statusDisplay').className = d.isLoggedIn ? 'status-ok' : 'status-warn';
    document.getElementById('statusDisplay').innerHTML = \`📋 \${d.message}<br>URL: \${d.url}\`;
  } catch(e) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ ' + e.message;
  }
  if(btn) { btn.disabled = false; btn.textContent = '🔑 前往登入頁'; }
}

// ── 注入 Cookies ──
async function injectCookies() {
  const btn = event?.target; if(btn) { btn.disabled = true; btn.textContent = '注入中...'; }
  const ta = document.getElementById('cookiesInput');
  let cookies;
  try { cookies = JSON.parse(ta.value); } catch(e) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ JSON 格式錯誤: ' + e.message;
    if(btn) { btn.disabled = false; btn.textContent = '📥 注入 Cookies'; }
    return;
  }
  if (!Array.isArray(cookies)) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ 需要 JSON 陣列，例如 [{name:"token", value:"xxx", domain:".qwen.ai"}]';
    if(btn) { btn.disabled = false; btn.textContent = '📥 注入 Cookies'; }
    return;
  }
  try {
    const r = await fetch('/ui/login/cookies', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cookies}) });
    const d = await r.json();
    document.getElementById('statusDisplay').className = d.isLoggedIn ? 'status-ok' : 'status-warn';
    document.getElementById('statusDisplay').innerHTML = \`🍪 已注入 \${d.injected} 個 cookies<br>登入狀態: \${d.isLoggedIn ? '✅ 已登入' : '❌ 未登入'}<br>URL: \${d.url}\`;
  } catch(e) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ 注入失敗: ' + e.message;
  }
  if(btn) { btn.disabled = false; btn.textContent = '📥 注入 Cookies'; }
}

// ── 儲存 Session ──
async function saveSession() {
  const btn = event?.target; if(btn) { btn.disabled = true; btn.textContent = '儲存中...'; }
  try {
    const r = await fetch('/ui/eval', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code:'JSON.stringify({url:location.href, cookies:document.cookie, hasToken:!!localStorage.getItem("token")})'}) });
    const d = await r.json();
    document.getElementById('statusDisplay').className = 'status-ok';
    document.getElementById('statusDisplay').innerHTML = \`💾 Session 已儲存至 Chrome profile<br>\${d.result || 'ok'}\`;
    // 觸發 cookie 萃取
    await fetch('/ui/eval', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code:'1'}) });
  } catch(e) {
    document.getElementById('statusDisplay').className = 'status-err';
    document.getElementById('statusDisplay').textContent = '❌ 儲存失敗: ' + e.message;
  }
  if(btn) { btn.disabled = false; btn.textContent = '💾 儲存 Session'; }
}

// 自動檢查狀態
checkStatus();
</script>
</body>
</html>`;

async function handleUIRequest(req, res, body) {
  const reqPath = req.url || "/";
  if (!reqPath.startsWith("/ui/")) return false;

  // 解析 JSON body
  let jsonBody = {};
  try {
    if (body && body.length > 0) jsonBody = JSON.parse(body.toString("utf-8"));
  } catch {
    sendJSON(res, 400, { error: "invalid_json" });
    return true;
  }

  // ── POST /ui/discover — 探索 DOM 結構 ──
  if (reqPath === "/ui/discover") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const result = await discoverSelectors(page);
      sendJSON(res, 200, result);
    } catch (e) {
      log("E", `discover 失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── POST /ui/eval — 在頁面執行 JS ──
  if (reqPath === "/ui/eval") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const code = jsonBody.code || jsonBody.js || "";
      if (!code) {
        sendJSON(res, 400, { error: "code_required" });
        return true;
      }
      log("I", `執行 JS: ${code.slice(0, 100)}`);
      const result = await page.evaluate((c) => eval(c), code);
      sendJSON(res, 200, { result });
    } catch (e) {
      log("E", `eval 失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── POST /ui/chat/navigate — 導航到指定路徑 ──
  if (reqPath === "/ui/chat/navigate") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const path = jsonBody.path || "/c/guest";
      const target = `https://chat.qwen.ai${path}`;
      log("I", `導航到: ${target}`);
      // 優化：網速慢時 networkidle2 極易超時，改為 domcontentloaded 即可，後續有 textarea 輪詢兜底
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2000);
      // P39: 等待 textarea 出現，確認 SPA 已完整渲染聊天 UI
      let textareaFound = false;
      const textareaDeadline = Date.now() + 15000;
      while (Date.now() < textareaDeadline) {
        try {
          textareaFound = await page.evaluate(() => {
            const ta = document.querySelector(
              "textarea.message-input-textarea",
            );
            if (!ta) return false;
            const box = ta.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          });
          if (textareaFound) break;
        } catch {}
        await sleep(500);
      }
      if (textareaFound) {
        log("I", `textarea 就緒，頁面已完全載入 (${path})`);
      } else {
        log("W", `導航後 textarea 未在 15s 內出現 (${path})，繼續嘗試發送`);
      }
      sendJSON(res, 200, {
        url: page.url(),
        title: await page.title(),
        textareaReady: textareaFound,
      });
    } catch (e) {
      log("E", `導航失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message, url: page.url() });
    }
    return true;
  }

  // ── POST /ui/chat/new — 透過 UI 建立新對話 ──
  if (reqPath === "/ui/chat/new") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const timeout = jsonBody.timeout || 20000;
      const result = await createNewChat(page, { timeout });
      if (result.chatId) {
        sendJSON(res, 200, {
          chatId: result.chatId,
          url: result.url,
          method: result.method,
        });
      } else {
        sendJSON(res, 502, {
          error: "chat_creation_failed",
          url: result.url,
          method: result.method,
        });
      }
    } catch (e) {
      log("E", `chat/new 失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /ui/status — 回傳目前瀏覽器登入狀態 ──
  if (reqPath === "/ui/status" && req.method === "GET") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        cookieCount: document.cookie ? document.cookie.split(";").length : 0,
        hasToken: !!localStorage.getItem("token"),
      }));
      sendJSON(res, 200, {
        url: info.url,
        title: info.title,
        cookieCount: info.cookieCount,
        hasToken: info.hasToken,
        pageReady,
        chromeAlive: browserAlive(),
      });
    } catch (e) {
      log("E", `status 失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── POST /ui/login — 導航到 qwen.ai 登入頁面 ──
  if (reqPath === "/ui/login" && req.method === "POST") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    const loginUrl = jsonBody.url || "https://chat.qwen.ai/auth/login";
    try {
      log("I", `導航到登入頁: ${loginUrl}`);
      // 優化：網速慢時 networkidle2 極易超時，改為 domcontentloaded 即可
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3000);
      const curUrl = page.url();
      const isLoggedIn = !curUrl.includes("login") && !curUrl.includes("auth");
      sendJSON(res, 200, {
        url: curUrl,
        title: await page.title(),
        isLoggedIn,
        message: isLoggedIn
          ? "✅ 已登入狀態"
          : "請在瀏覽器中完成登入，完成後按「檢查登入狀態」",
      });
    } catch (e) {
      log("E", `登入導航失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── POST /ui/login/cookies — 手動注入 cookies（從真實瀏覽器貼入）──
  if (reqPath === "/ui/login/cookies" && req.method === "POST") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    const cookies = jsonBody.cookies;
    if (!cookies || !Array.isArray(cookies)) {
      sendJSON(res, 400, {
        error: "cookies_required",
        hint: "需要傳入 cookies 陣列 [{name, value, domain, ...}]",
      });
      return true;
    }
    try {
      // 清除現有 cookies（避免衝突）
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      // 逐個設定 cookies
      for (const c of cookies) {
        try {
          await page.setCookie(c);
        } catch (e2) {
          log("D", `設定 cookie ${c.name} 失敗: ${e2.message}`);
        }
      }
      // 刷新頁面使 cookies 生效
      await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
      await sleep(2000);
      const curUrl = page.url();
      const isLoggedIn = !curUrl.includes("login") && !curUrl.includes("auth");
      log("I", `cookie 注入完成: ${cookies.length} 個, 登入狀態=${isLoggedIn}`);
      sendJSON(res, 200, {
        injected: cookies.length,
        url: curUrl,
        title: await page.title(),
        isLoggedIn,
      });
    } catch (e) {
      log("E", `cookie 注入失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ── POST /ui/chat/send — 透過 UI 發送訊息，SSE 串流回應 ──
  if (reqPath === "/ui/chat/send") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }

    const message = jsonBody.message || jsonBody.content || "";
    const chatId = jsonBody.chatId || jsonBody.chat_id || null;
    // P47: 預設 300s=5min（匹配 request.js 的 bpTimeout cap）
    // 舊值 120s 在 95K 訊息 + qwen3.6-max-preview 時常不足
    // request.js 會傳入自適應 timeout，此處當作硬上限
    const timeout = jsonBody.timeout || 300000;

    if (!message) {
      sendJSON(res, 400, { error: "message_required" });
      return true;
    }

    // 限制訊息長度：RPA 有 100K 字符限制
    const MAX_RPA_CHARS = 100000;
    if (message.length > MAX_RPA_CHARS) {
      log(
        "W",
        `訊息過長 (${message.length}字) 超過 RPA 限制 ${MAX_RPA_CHARS}，拒絕發送`,
      );
      sendJSON(res, 413, {
        error: `message_too_long: ${message.length} > ${MAX_RPA_CHARS}`,
      });
      return true;
    }

    const ac = new AbortController();
    const signal = ac.signal;

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // 客戶端斷線清理
    req.on("close", () => {
      try {
        ac.abort();
      } catch {}
    });

    // P42: RPA send timeout — 自適應長訊息
    // 大型 prompt 需要更長 model thinking 時間（95K chars 可能需 180s+）
    // 公式：base 60s + (char/1000)*5s，上限 min(userTimeout, 300s)
    // 注意：60s base 已預留 AI 生成時間 + 一次 retry（~10s 頁面刷新 + 重新發送）
    const adaptiveBp = Math.max(
      60000,
      Math.ceil(message.length / 1000) * 5000 + 30000,
    );
    const RPA_TIMEOUT = Math.min(adaptiveBp, Math.min(timeout, 300000));
    // P47: 若自適應值遠大於使用者 timeout，記錄警告（方便除錯 timeout 問題）
    if (adaptiveBp > Math.min(timeout, 300000)) {
      log(
        "W",
        `RPA_TIMEOUT 被使用者 timeout 限制: 自適應 ${Math.round(adaptiveBp / 1000)}s → 實際 ${Math.round(RPA_TIMEOUT / 1000)}s (訊息 ${message.length} 字)`,
      );
    }
    let chunkCount = 0;
    let rpaDone = false;

    // 帶超時的 sendAndMonitor 包裝
    const runRPA = async (retryCount = 0) => {
      if (signal.aborted) return { text: "", done: false, error: "aborted" };

      // P45: 確保從可用頁面開始（避免點擊新對話按鈕觸發 SPA 導航銷毀 context）
      // qwen.ai 首頁已有 textarea，發送訊息會自動建立新對話
      if (retryCount === 0) {
        try {
          const curUrl = page.url();
          // 若已在 /c/ 路徑或首頁，跳過導航（SPA 會自動處理新對話）
          if (
            curUrl.includes("/c/") ||
            curUrl === TARGET_URL + "/" ||
            curUrl === TARGET_URL
          ) {
            log("I", `[RPA] 頁面可用: ${curUrl}`);
          } else {
            log("I", "[RPA] 導航到首頁...");
            await page.goto(TARGET_URL + "/", {
              waitUntil: "networkidle2",
              timeout: 20000,
            });
            await sleep(3000);
            log("I", `[RPA] 導航完成: ${page.url()}`);
          }
        } catch (e) {
          log("W", `[RPA] 導航到首頁失敗: ${e.message}，繼續嘗試發送`);
        }
      }

      // 若重試則先刷新頁面
      if (retryCount > 0) {
        log("W", `RPA 重試 #${retryCount}，重新整理頁面...`);
        pageReady = false;
        // P42: 檢查當前頁面狀態，若已被 redirect 到 /auth 則放棄重試
        const curUrl = page.url();
        if (curUrl.includes("/auth")) {
          log(
            "W",
            "RPA 重試：頁面已跳轉到登入頁，放棄重試（需手動重新登入 qwen.ai）",
          );
          return { text: "", done: false, error: "redirected_to_auth" };
        }
        try {
          // P42: 使用頁面 origin 的根路徑重新導航，避免 /c/guest 被 redirect 到 /auth
          const origin = new URL(curUrl).origin;
          await page.goto(origin + "/", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          // 再次檢查是否被 redirect 到 /auth（有些 SPA 會非同步跳轉）
          await sleep(1000);
          const afterUrl = page.url();
          if (afterUrl.includes("/auth")) {
            log("W", "RPA 重試：導航後仍跳轉到登入頁，放棄重試");
            return { text: "", done: false, error: "redirected_to_auth" };
          }
          // 等待 textarea 出現（SPA 需要 hydration，可能需多次重試）
          let textareaStable = false;
          for (let i = 0; i < 40; i++) {
            if (signal.aborted)
              return { text: "", done: false, error: "aborted" };
            const hasTa = await page
              .evaluate(() => {
                const ta = document.querySelector("textarea");
                return ta && ta.offsetWidth > 0;
              })
              .catch(() => false);
            if (hasTa) {
              // 確認 textarea 穩定存在（SPA 不會再二次渲染把它 remove）
              // 等 500ms 再檢查一次仍可見才視為穩定
              if (textareaStable) break;
              textareaStable = true;
              await sleep(500);
              continue;
            }
            textareaStable = false;
            await sleep(500);
          }
          if (!textareaStable) {
            log("E", "RPA 重試：重整後找不到 textarea");
            return { text: "", done: false, error: "reload_no_textarea" };
          }
          pageReady = true;
          // 穩定延遲：讓 SPA 完成剩餘 hydration 再開始發送
          await sleep(1500);
          log("I", "RPA 重試：頁面已重新整理");
        } catch (e) {
          log("E", `RPA 重試：頁面重新整理失敗 ${e.message}`);
          return {
            text: "",
            done: false,
            error: `reload_failed: ${e.message}`,
          };
        }
      }

      // 使用 Promise.race：RPA vs timeout
      const rpaPromise = sendAndMonitor(page, message, {
        chatId,
        signal,
        timeout: RPA_TIMEOUT,
        onChunk: ({ text, fullText, done }) => {
          if (text) {
            chunkCount++;
            const safe = JSON.stringify({
              text,
              fullText: fullText.slice(-500),
            });
            _safeResWrite(res, `data: ${safe}\n\n`);
          }
          if (done) {
            rpaDone = true;
            _safeResWrite(
              res,
              `data: {"done":true,"totalChunks":${chunkCount}}\n\n`,
            );
            try {
              res.end();
            } catch {}
          }
        },
      });

      // P39: RPA timeout（比 qwen2api 的 20s socket timeout 短，避免 socket 先斷）
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RPA_TIMEOUT")), RPA_TIMEOUT),
      );

      try {
        return await Promise.race([rpaPromise, timeoutPromise]);
      } catch (e) {
        if (e.message === "RPA_TIMEOUT") {
          // RPA 卡住（可能是 pageerror 導致 page.evaluate hang）
          // 注意：不在此呼叫 ac.abort() — 會讓 signal.aborted=true 導致重試秒回
          // hanging evaluate 在後續 page.goto() 時 CDP 會自動取消
          if (!rpaDone && retryCount === 0) {
            // 重試一次：重新整理頁面再試
            log("W", "RPA 超時，重新整理頁面重試...");
            return runRPA(retryCount + 1);
          }
        }
        return { text: "", done: false, error: e.message };
      }
    };

    // 排隊等候 mutex（一次只處理一個 RPA 請求）
    // 若排隊中 client 斷線 signal.aborted → 直接跳過不執行
    if (rpaQueueLen > 1) log("D", `RPA 排隊中 (隊列長度=${rpaQueueLen})`);
    let rpaErr = null;
    const result = await withRPAMutex(() => runRPA(0), signal).catch((e) => {
      rpaErr = e.message;
      return null;
    });
    if (rpaErr === "canceled_while_queued") {
      log("D", "RPA 排隊中被取消（client 斷線）");
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {}
      }
      return true;
    }
    if (!rpaDone && !res.writableEnded) {
      if (result?.error) {
        log("W", `RPA 最終結果: ${result.error}`);
        _safeResWrite(
          res,
          `data: {"error":"${result.error.replace(/"/g, '\\"')}","done":true}\n\n`,
        );
      } else {
        const tail = (result?.text || "").slice(-100).replace(/"/g, '\\"');
        _safeResWrite(
          res,
          `data: {"done":true,"totalText":"${tail}"}\n\n`,
        );
      }
      try {
        res.end();
      } catch {}
    }
    return true;
  }

  // ── GET /ui/diag — 頁面診斷資訊 ──
  if (reqPath === "/ui/diag") {
    if (!page || !pageReady) {
      sendJSON(res, 502, { error: "browser_not_ready" });
      return true;
    }
    try {
      const diag = await page.evaluate(() => {
        const ta = document.querySelector("textarea.message-input-textarea");
        const msgs = document.querySelectorAll(".qwen-chat-message-assistant");
        const lastMsg = msgs[msgs.length - 1];
        const errPatterns = [
          "已達到每日使用限制",
          "daily usage limit",
          "rate limit",
          "too many requests",
        ];
        const errText = lastMsg ? lastMsg.textContent.trim() : "";
        const isLimited = errPatterns.some((p) =>
          errText.toLowerCase().includes(p.toLowerCase()),
        );
        return {
          url: location.href,
          title: document.title,
          textarea: {
            exists: !!ta,
            disabled: ta?.disabled || false,
            placeholder: ta?.placeholder || "",
            valueLen: ta?.value?.length || 0,
          },
          assistantMsgs: msgs.length,
          lastMsgPreview: errText.slice(0, 120),
          isRateLimited: isLimited,
          authButtons: [...document.querySelectorAll("button")]
            .filter((b) =>
              ["登入", "login", "註冊", "register", "sign"].some((k) =>
                (b.textContent || "").toLowerCase().includes(k),
              ),
            )
            .map((b) => b.textContent.trim()),
        };
      });
      sendJSON(res, 200, diag);
    } catch (e) {
      log("E", `diag 失敗: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // 未知的 /ui/* 路由
  sendJSON(res, 404, { error: "ui_route_not_found" });
  return true;
}

// ── HTTP 代理伺服器（在瀏覽器內發起請求，繞過 WAF JS challenge） ──
// WAF 需要真實瀏覽器執行 JS challenge。Node.js fetch 即使帶 cookies 也會被擋。
// 解法：用 page.evaluate() 在瀏覽器內 fetch，瀏覽器自動處理 WAF challenge。

async function proxyRequest(req, res) {
  const reqPath = req.url || "/";

  if (reqPath === "/health" || reqPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        pageReady,
        uptime: process.uptime(),
        chromeAlive: browserAlive(),
      }),
    );
    return;
  }

  // ── GET /login — qwen.ai 登入幫助頁面 ──
  if (reqPath === "/login" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE_HTML);
    return;
  }

  // 先讀取 body（UI 路由和非 UI 路由都需要）
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  // 先嘗試 UI 自動化路由
  const handled = await handleUIRequest(req, res, body);
  if (handled !== false) return;

  // ── RPA interception: POST /api/v2/chats/new ──
  // WAF blocks this endpoint with CAPTCHA. Instead of clicking UI (which doesn't
  // reliably produce a chat ID in the URL), extract the chat ID from the current
  // page URL. The SPA is already at /c/guest or /c/<uuid> after loading.
  // Falls through to CDP fetch if page not ready.
  if (reqPath === "/api/v2/chats/new" && req.method === "POST") {
    if (page && pageReady && !page.isClosed() && browserAlive()) {
      const chatId = await withRPAMutex(async () => {
        const curUrl = page.url();
        // Try to extract chat ID from current URL (guest or UUID)
        const match = curUrl.match(/\/c\/([a-f0-9-]{36}|guest)\b/i);
        if (match) {
          log("I", `[RPA] 從 URL 取得 chat_id: ${match[1]} (${curUrl})`);
          return match[1];
        }
        // No chat ID in URL — 生成隨機 UUID 作為 chat_id
        // qwen.ai 首頁輸入訊息會自動建立新對話，chat_id 僅用於請求追蹤
        const genId = crypto.randomUUID();
        log("I", `[RPA] URL 無 chat_id，生成隨機 UUID: ${genId}`);
        // 確保 page 在首頁（有 textarea 可發送）
        try {
          const curUrl = page.url();
          if (
            !curUrl.includes("/c/") &&
            curUrl !== TARGET_URL + "/" &&
            curUrl !== TARGET_URL
          ) {
            await page.goto(TARGET_URL + "/", {
              waitUntil: "networkidle2",
              timeout: 20000,
            });
            await sleep(2000);
          }
        } catch {}
        return genId;
      }, null).catch(() => null);

      if (chatId) {
        const respData = {
          data: {
            id: chatId,
            title: "New Chat",
            created_at: new Date().toISOString(),
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respData));
        return;
      }
      log("W", "[RPA] 無法取得 chat_id，降級到 CDP fetch");
    } else {
      log("W", "[RPA] 頁面未就緒，chats/new 降級到 CDP fetch");
    }
  }

  if (!page || !pageReady) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "browser_not_ready" }));
    return;
  }

  const fullUrl = `${TARGET_URL}${reqPath}`;
  const method = req.method || "GET";

  // 準備要在瀏覽器內 fetch 的參數
  // 轉發原始 headers（跳過 hop-by-hop 和瀏覽器禁止的）
  const skipHdrs = new Set([
    "transfer-encoding",
    "connection",
    "keep-alive",
    "host",
    "origin",
    "referer",
    "content-length",
    "accept-encoding",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ]);
  const fwdHdrs = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (!skipHdrs.has(lk) && typeof v === "string") fwdHdrs[lk] = v;
  }
  // 維持必要 header
  if (!fwdHdrs["accept"]) fwdHdrs["accept"] = "*/*";
  if (!fwdHdrs["content-type"]) fwdHdrs["content-type"] = "application/json";
  fwdHdrs["x-request-source"] = "browser-proxy";

  // 忽略上游傳入的 Authorization header，強制使用瀏覽器 localStorage token
  // 確保 token 與瀏覽器 cookies/session 一致，避免 data.json token 過期或衝突
  delete fwdHdrs["authorization"];
  if (page && !page.isClosed()) {
    try {
      const token = await page.evaluate(() => localStorage.getItem("token"));
      if (token && token.startsWith("eyJ")) {
        fwdHdrs["authorization"] = `Bearer ${token}`;
        log("D", `使用 localStorage token (${token.substring(0, 20)}...)`);
      } else {
        log("D", "localStorage 無有效 token");
      }
    } catch (e) {
      log("D", `讀取 localStorage token 失敗: ${e.message}`);
    }
  }

  const fetchOpts = {
    method,
    headers: fwdHdrs,
    credentials: "include",
  };
  if (method !== "GET" && method !== "HEAD" && body.length > 0)
    fetchOpts.body = body.toString("utf-8");

  const isSSE = req.headers["accept"]?.includes("text/event-stream");
  log("D", `${method} ${reqPath} SSE=${isSSE}`);

  try {
    if (isSSE) {
      // ── SSE 串流：瀏覽器端用 ReadableStream 讀取 → polling 吐回 ──
      const ns = "bp_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const target = proxyPage || page;
      await target.evaluate(
        (url, opts, ns) => {
          const state = { chunks: [], done: false, status: 0, err: null };
          window[ns] = state;
          fetch(url, { ...opts, signal: AbortSignal.timeout(600000) })
            .then(async (r) => {
              state.status = r.status;
              const reader = r.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                state.chunks.push(new TextDecoder().decode(value));
              }
              state.done = true;
            })
            .catch((e) => {
              state.err = e.message;
              state.done = true;
            });
        },
        fullUrl,
        fetchOpts,
        ns,
      );

      // polling 直到完成或中斷
      let status = 0;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const poll = setInterval(async () => {
        try {
          const s = await target.evaluate(
            (ns) =>
              window[ns] || {
                chunks: [],
                done: true,
                status: 0,
                err: "ns_gone",
              },
            ns,
          );
          status = s.status;
          for (const c of s.chunks) {
            if (!_safeResWrite(res, c)) {
              clearInterval(poll);
              try {
                res.end();
              } catch {}
              break;
            }
          }
          s.chunks.length = 0;
          if (s.err) log("E", `瀏覽器 SSE 錯誤: ${s.err}`);
          if (s.done) {
            clearInterval(poll);
            try {
              res.end();
            } catch {}
            target.evaluate((ns) => delete window[ns], ns).catch(() => {});
          }
        } catch (e) {
          clearInterval(poll);
          try {
            res.end();
          } catch {}
        }
      }, 100);
      req.on("close", () => {
        clearInterval(poll);
        target.evaluate((ns) => delete window[ns], ns).catch(() => {});
      });
    } else {
      // ── 非 SSE：在瀏覽器內 fetch 完整回應（附超時） ──
      // 使用 CDP waitForResponse 作為主要路徑（不受 SPA 導航影響）
      // evaluate 僅用於觸發瀏覽器內的 fetch，不依賴其返回值
      const target = proxyPage || page;

      // 註冊 CDP response 監聽（在 evaluate 執行 fetch 之前註冊，確保不漏接）
      const cdpResultPromise = target
        .waitForResponse(
          (r) => r.url() === fullUrl && r.status() >= 200 && r.status() < 500,
          { timeout: 120000 },
        )
        .then(async (r) => {
          if (!r) return null;
          const ct = r.headers()["content-type"] || "";
          const hdrs = {};
          for (const [k, v] of Object.entries(r.headers())) hdrs[k] = v;
          const body = ct.includes("json")
            ? JSON.stringify(await r.json())
            : await r.text();
          log(
            "D",
            `CDP 捕獲回應: ${r.status()} ${ct} (${(body.length / 1024).toFixed(1)}KB)`,
          );
          return { status: r.status(), headers: hdrs, body };
        })
        .catch(() => null);

      // 啟動瀏覽器內 fetch（fire-and-forget，用於觸發請求）
      // 即使 SPA 導航銷毀 evaluate context 也不影響 CDP 監聽
      target
        .evaluate(
          async (url, opts) => {
            try {
              await fetch(url, {
                ...opts,
                signal: AbortSignal.timeout(120000),
              });
            } catch (_) {
              /* CDP handles response */
            }
          },
          fullUrl,
          fetchOpts,
        )
        .catch(() => {});

      // 等待 CDP 回應（通常在數百 ms 內返回）
      const result = await cdpResultPromise;

      if (!result) {
        log("E", `CDP 無回應 ${reqPath}`);
        if (!res.headersSent)
          res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "cdp_no_response" }));
        return;
      }

      const rHeaders = {};
      for (const [k, v] of Object.entries(result.headers)) {
        const lk = k.toLowerCase();
        if (
          [
            "transfer-encoding",
            "connection",
            "keep-alive",
            "content-encoding",
            "content-length",
          ].includes(lk)
        )
          continue;
        if (lk === "content-type" && v.includes("text/html"))
          rHeaders[k] = v.replace("text/html", "text/plain");
        else rHeaders[k] = v;
      }
      res.writeHead(result.status, rHeaders);
      res.end(result.body);
    }
  } catch (e) {
    log("E", `代理錯誤 ${reqPath}: ${e.message}`);
    if (!res.headersSent)
      res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: e.message }));
  }
}

// ── 主啟動 ────────────────────────────────────────────────────────

async function main() {
  const isDaemon = process.argv.includes("--daemon");

  if (isDaemon) {
    const child = spawn(
      process.argv[0],
      process.argv.filter((a) => a !== "--daemon"),
      { stdio: "ignore", detached: true },
    );
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`browser-proxy 已在背景啟動 (PID: ${child.pid})`);
    process.exit(0);
  }

  logInit();
  log("I", `=== browser-proxy 啟動 (port ${PORT}) ===`);

  // 啟動 Chrome headless
  await startBrowser();

  // ── 背景排程（遞迴 setTimeout 替代 setInterval + async callback） ──

  let _cookieTimer = null;
  async function cookieLoop() {
    if (shuttingDown) return;
    await refreshSession().catch(() => {});
    if (!shuttingDown) _cookieTimer = setTimeout(cookieLoop, COOKIE_REFRESH_MS);
  }
  _cookieTimer = setTimeout(cookieLoop, COOKIE_REFRESH_MS);

  let _tokenTimer = null;
  async function tokenLoop() {
    if (shuttingDown) return;
    await refreshToken().catch(() => {});
    if (!shuttingDown) _tokenTimer = setTimeout(tokenLoop, TOKEN_REFRESH_MS);
  }
  _tokenTimer = setTimeout(tokenLoop, TOKEN_REFRESH_MS);

  let _watchdogTimer = null;
  async function watchdogLoop() {
    if (shuttingDown) return;
    try {
      const ok = page && !page.isClosed() && browserAlive();
      if (!ok && pageReady) {
        log("W", "Watchdog 偵測異常，恢復中...");
        pageReady = false;
        if (browserAlive()) {
          try {
            const pages = await browser.pages();
            page = pages[0] || (await browser.newPage());
            await page.goto(TARGET_URL, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
            await extractCookies();
            pageReady = true;
            log("I", "Watchdog 恢復成功");
          } catch (e) {
            log("E", `Watchdog 恢復失敗: ${e.message}`);
            startBrowser().catch(() => {});
          }
        } else {
          startBrowser().catch(() => {});
        }
      }
    } finally {
      if (!shuttingDown) _watchdogTimer = setTimeout(watchdogLoop, WATCHDOG_MS);
    }
  }
  _watchdogTimer = setTimeout(watchdogLoop, WATCHDOG_MS);

  // HTTP 伺服器
  const server = http.createServer(proxyRequest);
  server.setTimeout(0); // 禁用預設 120s socket timeout，避免模型思考期間無資料流導致 server 先斷
  server.listen(PORT, "127.0.0.1", () => {
    log("I", `Proxy 聆聽 http://127.0.0.1:${PORT}`);
    log("I", `管理面板: http://127.0.0.1:8317/management.html`);
  });

  // 優雅關閉
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("I", `收到 ${sig}，關閉中...`);
    server.close(() => log("I", "伺服器已關閉"));
    // 清理背景排程
    clearTimeout(_cookieTimer);
    clearTimeout(_tokenTimer);
    clearTimeout(_watchdogTimer);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    if (_logFd !== null) {
      try {
        fs.closeSync(_logFd);
      } catch {}
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
