#!/usr/bin/env bun
/**
 * waf-proxy.js — WAF Bypass Proxy v9 (Browser-Only Streaming + Status Passthrough)
 *
 * Architecture:
 *   - Aliyun WAF NC is JavaScript-based (requires real browser JS engine).
 *   - Node.js fetch CANNOT bypass it — ALL streaming requests go through browser.
 *   - Pre-flight status check in browser before writing HTTP headers.
 *   - Upstream 401/403 → real HTTP error code passes through to qwen2api's retry.
 *   - Memory controlled via periodic browser restart (no --single-process).
 *
 * qwen2api → QWEN_CHAT_PROXY_URL=http://127.0.0.1:3457
 *   → waf-proxy:3457 → chat.qwen.ai
 */

const http = require("http");
const puppeteer = require("puppeteer");

const PORT = parseInt(process.env.WAF_PROXY_PORT || "3457");
const TARGET = process.env.WAF_TARGET || "https://chat.qwen.ai";
const CHROME_PATH = process.env.CHROME_PATH;
const REFRESH_MS = parseInt(process.env.WAF_COOKIE_REFRESH || "300000"); // 5min
const RESTART_MS = parseInt(process.env.WAF_BROWSER_RESTART || "1800000"); // 30min
const STREAM_TIMEOUT = parseInt(process.env.WAF_STREAM_TIMEOUT || "600000");

let browser;
let cookieJar = "";

// ─── Browser management ───

async function ensureBrowser() {
  if (!browser || !browser.connected) {
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
        "--disable-features=Translate,ChromeWhatsNewUI,OptimizationHints,MediaRouter",
        "--mute-audio",
        "--no-first-run",
      ],
    });
    const pages = await browser.pages();
    for (const p of pages) p.close().catch(() => {});
  }
  return browser;
}

async function restartBrowser() {
  console.log("[waf] Restarting browser (memory maintenance)...");
  try {
    if (browser && browser.connected) await browser.close().catch(() => {});
  } catch {}
  browser = null;
  await ensureBrowser();
}

// ─── Page creation ───

async function createPage() {
  await ensureBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  );
  // Navigate to establish origin (React error #418 may occur but doesn't prevent fetch)
  page.on("pageerror", () => {}); // suppress React errors
  await page
    .goto(TARGET + "/", { waitUntil: "domcontentloaded", timeout: 15000 })
    .catch(() => {});
  return page;
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
    await ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
      );
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
    page.on("console", (msg) => {
      const t = msg.type();
      const txt = msg.text();
      if (txt === "[date Date]") return;
      if (txt.includes("401") || txt.includes("Failed to load resource"))
        return;
      if (txt.startsWith("[waf]")) return;
      if (t === "error" || t === "warning")
        console.log(`[browser] ${t}: ${txt}`);
    });
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
      console.error(`[waf] Browser status timeout`);
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
    await page.close().catch(() => {});
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
      try {
        if (isStream) {
          // Streaming → browser-only (Aliyun WAF NC). No headers written yet — proxyStreaming handles it.
          await proxyStreaming(req.method, req.url, req.headers, body, res);
        } else {
          const r = await proxySimple(req.method, req.url, req.headers, body);
          if (!res.headersSent) {
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          } else if (!res.writableEnded) res.end();
        }
      } catch (e) {
        console.error(`[waf] ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        } else if (!res.writableEnded) res.end();
      }
    });
  });
  srv.listen(PORT, "127.0.0.1", () =>
    console.log(`[waf] Listening on 127.0.0.1:${PORT}`),
  );
}

// ─── Main ───

async function main() {
  console.log(`[waf-proxy] Starting (target: ${TARGET})`);
  await ensureBrowser();
  await refreshCookies();
  startServer();
  setInterval(() => refreshCookies().catch(() => {}), REFRESH_MS);
  setInterval(() => restartBrowser().catch(() => {}), RESTART_MS);
  console.log("[waf-proxy] Ready (browser-only streaming, pre-flight status)");
}

main().catch((e) => {
  console.error("[waf-proxy] Fatal:", e.message);
  process.exit(1);
});
