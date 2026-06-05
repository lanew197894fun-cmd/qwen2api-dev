#!/usr/bin/env bun
/**
 * waf-proxy.js — WAF Bypass Proxy v10 (Page Pool + Request Queue + Throttle)
 *
 * Changes from v9:
 *   - Page POOL instead of createPage per request (reuse 1-2 pages)
 *   - Request QUEUE with max concurrency 1 (laptop-friendly)
 *   - Queue timeout to prevent cascade (don't let requests pile up forever)
 *   - Browser session health check before queue processing
 *   - Reduced concurrent page limit from 8 to 2
 *
 * Architecture:
 *   qwen2api → QWEN_CHAT_PROXY_URL=http://127.0.0.1:3457
 *     → waf-proxy:3457 → chat.qwen.ai
 */

const http = require("http");
const puppeteer = require("puppeteer");

const PORT = parseInt(process.env.WAF_PROXY_PORT || "3457");
const WAF_HOST = process.env.WAF_PROXY_HOST || "127.0.0.1";
const TARGET = process.env.WAF_TARGET || "https://chat.qwen.ai";
const CHROME_PATH = process.env.CHROME_PATH;
const REFRESH_MS = parseInt(process.env.WAF_COOKIE_REFRESH || "300000"); // 5min
const RESTART_MS = parseInt(process.env.WAF_BROWSER_RESTART || "3600000"); // 60min
const MEM_CHECK_MS = parseInt(process.env.WAF_MEM_CHECK || "60000"); // 60s
const MEM_RESTART_MB = parseInt(process.env.WAF_MEM_RESTART_MB || "1500"); // 1.5GB
const STREAM_TIMEOUT = parseInt(process.env.WAF_STREAM_TIMEOUT || "600000");

// ─── Queue / Pool config ───
const POOL_SIZE = parseInt(process.env.WAF_POOL_SIZE || "4"); // keep 4 pages warm for better concurrency
const MAX_CONCURRENT = parseInt(
  process.env.WAF_MAX_CONCURRENT || String(POOL_SIZE),
); // match pool size by default
const QUEUE_TIMEOUT = parseInt(process.env.WAF_QUEUE_TIMEOUT || "60000"); // max 60s wait in queue to reduce premature timeouts

let browser;
let cookieJar = "";
let browserPromise = null;
let restartState = { active: false };
let restartTimer = null;

// ─── Page pool ───
const pagePool = [];
let poolReady = false;

// ─── Request queue ───
const reqQueue = [];
let activeCount = 0;
let processingQueue = false;

// ─── Utils: suppress benign browser console noise ───
const SUPPRESS_PATTERNS = [
  "unload is not allowed",
  "Permissions policy violation",
  "[date Date]",
  "Failed to load resource",
];
function isSuppressed(txt) {
  if (!txt) return true;
  return SUPPRESS_PATTERNS.some((p) => txt.includes(p));
}

function suppressConsole(msg) {
  const t = msg.type();
  const txt = msg.text();
  if (!txt || isSuppressed(txt)) return;
  if (txt.startsWith("[waf]")) return;
  if (t === "error" || t === "warning") console.log(`[browser] ${t}: ${txt}`);
}

// ─── Queue entry ───
// { method, url, headers, body, res, startedAt }

// ─── Browser管理 ───

// 瀏覽器健康狀態追蹤
let browserHealth = {
  consecutiveTimeouts: 0,
  lastTimeoutAt: 0,
  totalRequests: 0,
  failedRequests: 0,
};

async function doLaunch() {
  browser = await puppeteer.launch({
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    headless: true,
    protocolTimeout: 600000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-component-extensions-with-background-pages",
      "--disable-sync",
      "--disable-extensions",
      "--disable-domain-reliability",
      "--disable-features=Translate,ChromeWhatsNewUI,OptimizationHints,MediaRouter,PermissionsPolicy",
      "--mute-audio",
      "--no-first-run",
      "--disable-features=Unload",
    ],
  });
  const pages = await browser.pages();
  for (const p of pages) p.close().catch(() => {});
  // Grace period: let browser settle to avoid "Requesting main frame too early"
  await new Promise((r) => setTimeout(r, 1000));
  return browser;
}

async function ensureBrowser() {
  if (browser && browser.connected) return browser;
  if (browserPromise) return browserPromise;
  browserPromise = doLaunch();
  try {
    const b = await browserPromise;
    await initPool(b);
    return b;
  } finally {
    browserPromise = null;
  }
}

// ─── Page pool: create and maintain reusable pages ───

async function initPool(b) {
  if (poolReady) return;
  await ensurePoolSize(b, POOL_SIZE);
  poolReady = true;
  console.log(`[waf] Page pool ready: ${pagePool.length} pages`);
}

async function ensurePoolSize(b, n) {
  while (pagePool.length < n) {
    try {
      const p = await b.newPage();
      await p.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      );
      p.on("pageerror", () => {});
      p.on("console", suppressConsole);
      await p
        .goto(TARGET + "/", { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
      // 不要導航到 about:blank — 保留在 TARGET 上使瀏覽器 fetch 的 origin 正確 (chat.qwen.ai)，
      // 避免 CORS 錯誤 (origin=null 被上游拒絕)
      pagePool.push(p);
    } catch (e) {
      console.error(`[waf] Pool create page error: ${e.message}`);
    }
  }
}

async function acquirePage() {
  await ensureBrowser();
  let p = pagePool.pop();
  if (!p || p.isClosed()) {
    p = null;
  }
  // 頁面 JS 執行能力檢查 — 拋棄幽靈頁面
  if (p) {
    try {
      await p.evaluate("1", { timeout: 5000 });
    } catch {
      console.log(`[waf] Page JS dead, discarding from pool`);
      try {
        if (!p.isClosed()) await p.close().catch(() => {});
      } catch {}
      p = null;
      browserHealth.failedRequests++;
    }
  }
  if (!p) {
    try {
      p = await browser.newPage();
      await p.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
      );
      p.on("pageerror", () => {});
      p.on("console", suppressConsole);
      // 新頁面導航到 TARGET 以獲得正確的 origin + cookies
      await p
        .goto(TARGET + "/", { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
    } catch (e) {
      console.error(`[waf] acquirePage new: ${e.message}`);
      return null;
    }
  }
  return p;
}

function releasePage(p) {
  if (!p || p.isClosed()) return;
  if (pagePool.length < POOL_SIZE * 2) {
    // 頁面保留在 TARGET origin 上（上次 fetch 後已在 chat.qwen.ai）
    // 不要導航 — 避免重載 React app（MB 級 JS），直接復用
    // 若瀏覽器 GC 回收了頁面上下文，下次 acquirePage 會重新導航
    pagePool.push(p);
  } else {
    p.close().catch(() => {});
  }
}

// ─── Request queue processing ───

function enqueueRequest(method, url, headers, body, res) {
  reqQueue.push({ method, url, headers, body, res, startedAt: Date.now() });
  if (!processingQueue) processQueue();
  // If queue is growing too fast, drain oldest
  while (reqQueue.length > 10) {
    const oldest = reqQueue.shift();
    if (oldest && !oldest.res.writableEnded) {
      try {
        oldest.res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "5",
        });
        oldest.res.end(JSON.stringify({ error: "queue_full" }));
      } catch {}
    }
  }
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (reqQueue.length > 0) {
    // Concurrency throttle
    if (activeCount >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const entry = reqQueue.shift();
    if (!entry) continue;
    // Check queue timeout
    if (Date.now() - entry.startedAt > QUEUE_TIMEOUT) {
      if (!entry.res.writableEnded) {
        try {
          entry.res.writeHead(504, { "Content-Type": "application/json" });
          entry.res.end(JSON.stringify({ error: "queue_timeout" }));
        } catch {}
      }
      continue;
    }
    activeCount++;
    processEntry(entry).finally(() => {
      activeCount--;
    });
  }
  processingQueue = false;
}

async function processEntry(entry) {
  const { method, url, headers, body, res } = entry;
  try {
    const isStream = url && url.includes("/chat/completions");
    if (isStream) {
      await proxyStreaming(method, url, headers, body, res);
    } else {
      const r = await proxySimple(method, url, headers, body);
      if (!res.headersSent) {
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      } else if (!res.writableEnded) res.end();
    }
  } catch (e) {
    console.error(`[waf] processEntry: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    } else if (!res.writableEnded) res.end();
  }
}

async function restartBrowser() {
  console.log("[waf] Restarting browser (memory maintenance)...");
  restartState.active = true;
  browserPromise = null;
  // Close all pooled pages
  for (const p of pagePool) {
    try {
      if (!p.isClosed()) await p.close().catch(() => {});
    } catch {}
  }
  pagePool.length = 0;
  poolReady = false;
  try {
    if (browser && browser.connected) await browser.close().catch(() => {});
  } catch {}
  browser = null;
  await ensureBrowser();
  await new Promise((r) => setTimeout(r, 3000));
  restartState.active = false;
  console.log("[waf] Browser restart complete, accepting requests");
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await restartBrowser();
    scheduleRestart(); // reschedule for next cycle
  }, RESTART_MS).unref();
}

async function checkMemory() {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  if (rssMB > MEM_RESTART_MB) {
    console.log(`[waf] Memory ${rssMB}MB > ${MEM_RESTART_MB}MB, early restart`);
    await restartBrowser();
    scheduleRestart(); // reset timer from now
  }
}

// ─── Page creation ───

async function createPage() {
  // Use the page pool instead of creating new pages per request
  if (restartState.active) return null;
  return acquirePage();
}

// ─── Cookie helpers ───

function parseSetCookie(v) {
  const out = [];
  const items = Array.isArray(v) ? v : [v];
  for (const i of items) {
    const p = i.split(";")[0].trim();
    const e = p.indexOf("=");
    if (e > 0) out.push({ name: p.slice(0, e), value: p.slice(e + 1) });
  }
  return out;
}

function mergeIntoCookieJar(parsed) {
  if (!parsed.length) return;
  const m = {};
  for (const c of cookieJar.split("; ").filter(Boolean)) {
    const e = c.indexOf("=");
    if (e > 0) m[c.slice(0, e)] = c.slice(e + 1);
  }
  for (const c of parsed) m[c.name] = c.value;
  cookieJar = Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function updateCookieJar(resp) {
  const sc = resp.headers.get("set-cookie");
  if (sc) mergeIntoCookieJar(parseSetCookie(sc));
}

async function syncCookies(page) {
  try {
    const c = await page.cookies();
    mergeIntoCookieJar(c.map((x) => ({ name: x.name, value: x.value })));
  } catch {}
}

async function refreshCookies() {
  try {
    // Bypass page semaphore — maintenance task must not contend with request pages.
    // During restart (restartState.active), ensureBrowser may wait for new browser.
    await ensureBrowser();
    if (restartState.active) return; // still restarting, skip this cycle
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      );
      page.on("pageerror", () => {});
      page.on("console", suppressConsole);
      await page
        .goto(TARGET + "/", { waitUntil: "networkidle0", timeout: 30000 })
        .catch(() => {});
      await syncCookies(page);
      console.log(
        `[waf] Cookies refreshed: ${cookieJar.split("; ").length} cookies`,
      );
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.error(`[waf] Cookie refresh error: ${err.message}`);
  }
}

function mergeCookies(incoming) {
  if (!cookieJar) return incoming || "";
  const m = {};
  for (const c of cookieJar.split("; ").filter(Boolean)) {
    const e = c.indexOf("=");
    if (e > 0) m[c.slice(0, e)] = c.slice(e + 1);
  }
  if (incoming) {
    for (const c of incoming.split(";").filter(Boolean)) {
      const t = c.trim();
      const e = t.indexOf("=");
      if (e > 0) m[t.slice(0, e)] = t.slice(e + 1);
    }
  }
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function isWaf(s) {
  const t = typeof s === "string" ? s.toLowerCase() : "";
  return (
    t.includes("aliyun_waf") ||
    t.includes("captcha-element") ||
    t.includes("waf_nc") ||
    t.includes("access verification")
  );
}

// ─── Non-streaming proxy (Node.js fetch, no WAF issue for non-API paths) ───

async function proxySimple(method, path, headers, body) {
  const url = TARGET + path;
  const h = {};
  for (const k of [
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "origin",
    "referer",
  ])
    if (headers[k]) h[k] = headers[k];
  h["cookie"] = mergeCookies(headers["cookie"] || headers["Cookie"] || "");
  if (!h["user-agent"])
    h["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36";
  if (!h["content-type"] && body) h["content-type"] = "application/json";
  const resp = await fetch(url, {
    method,
    headers: h,
    body: body || undefined,
  });
  updateCookieJar(resp);
  const text = await resp.text();
  const out = {};
  for (const [k, v] of resp.headers)
    if (
      !["transfer-encoding", "content-encoding", "content-length"].includes(k)
    )
      out[k] = v;
  return { status: resp.status, headers: out, body: text };
}

// ─── Streaming proxy (browser-only — Aliyun WAF NC, pre-flight status) ───

async function proxyStreaming(method, path, headers, body, res) {
  const url = TARGET + path;
  const fwd = {};
  const fwdKeys = [
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "origin",
    "referer",
    "bx-v",
    "source",
    "version",
    "x-request-id",
    "accept-language",
    "timezone",
    "sec-ch-ua",
  ];
  for (const k of fwdKeys) if (headers[k]) fwd[k] = headers[k];
  // Override referer/origin to target domain (incoming values are from proxy URL)
  fwd["referer"] = TARGET + "/c/guest";
  fwd["origin"] = TARGET;
  fwd["accept"] = "text/event-stream";
  if (!fwd["user-agent"])
    fwd["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
  if (!fwd["content-type"] && body) fwd["content-type"] = "application/json";

  const page = await createPage();
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      if (!res.writableEnded) res.end();
    }
  };

  try {
    page.on("console", suppressConsole);
    page.on("pageerror", () => {});

    const uid = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    const fnC = "c_" + uid,
      fnD = "d_" + uid,
      fnS = "s_" + uid;

    // Forward-reported status: resolve pre-flight promise
    let upStatus = 200;
    let statusResolve;
    const statusProm = new Promise((r) => {
      statusResolve = r;
    });

    await page.exposeFunction(fnS, (s) => {
      upStatus = s;
      statusResolve(s);
    });
    await page.exposeFunction(fnC, (chunk) => {
      if (!res.writableEnded && !ended)
        try {
          res.write(chunk);
        } catch {
          end();
        }
    });
    await page.exposeFunction(fnD, () => end());

    // Inject merged cookies
    const src = cookieJar ? cookieJar.split("; ").filter(Boolean) : [];
    const rc = headers["cookie"] || headers["Cookie"] || "";
    if (rc) {
      for (const c of rc
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const e = c.indexOf("=");
        if (e > 0) {
          const n = c.slice(0, e);
          const idx = src.findIndex((s) => s.startsWith(n + "="));
          if (idx >= 0) src.splice(idx, 1);
          src.push(c);
        }
      }
    }
    for (const c of src) {
      const e = c.indexOf("=");
      if (e > 0)
        try {
          await page.setCookie({
            name: c.slice(0, e),
            value: c.slice(e + 1),
            domain: ".chat.qwen.ai",
            path: "/",
          });
        } catch {}
    }

    // Page already navigated to TARGET in createPage() (with JS bundles blocked to prevent React crash)
    // Cookies set above on the existing page — no re-navigation needed
    await new Promise((r) => setTimeout(r, 500));

    // Phase 1: Execute fetch in browser — reports status FIRST via fnS, then streams chunks
    // Fetch timeout prevents browser from hanging on 401 body or slow upstream
    const FETCH_TIMEOUT = 60000;
    const js = `
      (async () => {
        const emit = (fn, ...a) => { try { if (typeof window[fn] === 'function') window[fn](...a); } catch(e) { console.error('[waf] emit err:', fn); } };
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), ${FETCH_TIMEOUT});
        try {
          const resp = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(fwd)},
            body: ${body ? JSON.stringify(body) : "undefined"},
            credentials: "same-origin",
            signal: ac.signal,
          });
          clearTimeout(to);
          // Phase 1: report status before any streaming
          emit(${JSON.stringify(fnS)}, resp.status);
          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            console.error("[waf] status:", resp.status);
            emit(${JSON.stringify(fnC)}, "data: " + JSON.stringify({ error: "upstream_" + resp.status, detail: text.slice(0, 300) }) + "\\n\\n");
            emit(${JSON.stringify(fnD)});
            return;
          }
          // Phase 2: stream SSE response
          const ct = (resp.headers.get("content-type") || "").toLowerCase();
          console.log("[waf] Upstream content-type:", ct);
          if (ct.includes("text/event-stream")) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let cnt = 0;
            let first = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              cnt++;
              if (cnt === 1) first = chunk.slice(0, 200);
              emit(${JSON.stringify(fnC)}, chunk);
            }
            console.log("[waf] Browser stream done, chunks:", cnt, "first:", JSON.stringify(first));
          } else {
            const text = await resp.text();
            emit(${JSON.stringify(fnC)}, text);
          }
          emit(${JSON.stringify(fnD)});
        } catch (e) {
          clearTimeout(to);
          if (e.name === 'AbortError') {
            console.error("[waf] Browser fetch timeout");
            emit(${JSON.stringify(fnC)}, "data: " + JSON.stringify({ error: "timeout" }) + "\\n\\n");
          } else {
            console.error("[waf] Browser fetch error:", e.message);
            emit(${JSON.stringify(fnC)}, "data: " + JSON.stringify({ error: "browser_fetch_error", detail: e.message }) + "\\n\\n");
          }
          emit(${JSON.stringify(fnD)});
        }
      })();
    `;
    // Evaluate without waiting (streaming is async in browser)
    const evalProm = page.evaluate(js).catch(() => {});

    // Wait for status report from browser (with timeout)
    const status = await Promise.race([
      statusProm,
      new Promise((r) => setTimeout(() => r(0), 30000)), // 30s browser timeout
    ]);

    if (status === 0) {
      // Browser didn't respond — timeout
      browserHealth.consecutiveTimeouts++;
      browserHealth.lastTimeoutAt = Date.now();
      browserHealth.failedRequests++;
      console.error(
        `[waf] Browser status timeout (x${browserHealth.consecutiveTimeouts})`,
      );
      // 達到連續逾時閾值 → 立即重啟瀏覽器
      if (browserHealth.consecutiveTimeouts >= 3) {
        console.error(
          `[waf] ⚠️ 連續 ${browserHealth.consecutiveTimeouts} 次逾時，強制重啟瀏覽器`,
        );
        browserHealth.consecutiveTimeouts = 0;
        restartBrowser().catch(() => {});
      }
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "browser_timeout" }));
      } else if (!res.writableEnded) res.end();
      evalProm.catch(() => {});
      return;
    }

    if (status !== 200) {
      // Non-200: write real HTTP error code (triggers qwen2api retry)
      if (!res.headersSent) {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: "upstream_error", status }));
      }
      console.log(`[waf] Upstream ${status}, returned as real HTTP status`);
      // Do NOT await evalProm — browser may be stuck reading 401 body.
      // The request is already ended; let browser clean up on its own.
      evalProm.catch(() => {});
      return;
    }

    // 200: write SSE headers now
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }

    // Phase 2 streaming continues via fnC/fnD callbacks
    await evalProm;
  } catch (e) {
    console.error(`[waf] Streaming error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    } else if (!res.writableEnded) res.end();
  } finally {
    await syncCookies(page);
    // 若頁面已死，不要放回 pool
    if (page && !page.isClosed()) {
      try {
        await page.evaluate("1", { timeout: 2000 });
        releasePage(page);
      } catch {
        console.log(`[waf] Discarding dead page after streaming`);
        try {
          if (!page.isClosed()) await page.close().catch(() => {});
        } catch {}
      }
    } else if (page) {
      releasePage(page);
    }
  }
}

// ─── HTTP server ───

function startServer() {
  const srv = http.createServer((req, res) => {
    req.socket.setTimeout(STREAM_TIMEOUT);
    const buf = [];
    req.on("data", (c) => buf.push(c));
    req.on("end", async () => {
      const body = buf.length ? Buffer.concat(buf).toString() : null;
      const isStream = req.url && req.url.includes("/chat/completions");

      // ── Fast 503 during browser restart ──
      if (restartState.active) {
        if (!res.headersSent) {
          res.writeHead(503, {
            "Content-Type": "application/json",
            "Retry-After": "15",
          });
          res.end(JSON.stringify({ error: "waf_restarting" }));
        }
        return;
      }

      // ── Streaming → enqueue (throttled by request queue) ──
      // Non-streaming → direct (lightweight, no browser needed)
      if (isStream) {
        enqueueRequest(req.method, req.url, req.headers, body, res);
      } else {
        try {
          const r = await proxySimple(req.method, req.url, req.headers, body);
          if (!res.headersSent) {
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          } else if (!res.writableEnded) res.end();
        } catch (e) {
          console.error(`[waf] ${e.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          } else if (!res.writableEnded) res.end();
        }
      }
    });
  });
  srv.listen(PORT, WAF_HOST, () =>
    console.log(`[waf] Listening on ${WAF_HOST}:${PORT}`),
  );
}

// ─── Page health monitor ───

async function checkPoolHealth() {
  if (restartState.active || !browser?.connected) return;
  let healthy = 0;
  const toRemove = [];
  for (const p of pagePool) {
    if (p.isClosed()) {
      toRemove.push(p);
      continue;
    }
    try {
      await p.evaluate("1", { timeout: 5000 });
      healthy++;
    } catch {
      toRemove.push(p);
      try {
        if (!p.isClosed()) await p.close().catch(() => {});
      } catch {}
    }
  }
  // Remove dead pages from pool
  for (const p of toRemove) {
    const idx = pagePool.indexOf(p);
    if (idx >= 0) pagePool.splice(idx, 1);
  }
  // Replenish if below minimum
  if (healthy < POOL_SIZE && browser?.connected) {
    await ensurePoolSize(browser, POOL_SIZE);
  }
}

// ─── Main ───

async function main() {
  console.log(`[waf-proxy] Starting (target: ${TARGET})`);
  await ensureBrowser();
  await refreshCookies();
  startServer();
  setInterval(() => refreshCookies().catch(() => {}), REFRESH_MS);
  setInterval(() => checkMemory().catch(() => {}), MEM_CHECK_MS);
  setInterval(() => checkPoolHealth().catch(() => {}), 15000); // P0: pool health check every 15s
  scheduleRestart();
  console.log("[waf-proxy] Ready (browser-only streaming, pre-flight status)");
}

main().catch((e) => {
  console.error("[waf-proxy] Fatal:", e.message);
  process.exit(1);
});
