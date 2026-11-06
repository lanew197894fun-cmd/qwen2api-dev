const puppeteer = require("puppeteer-core");
const http = require("http");

const PORT = parseInt(process.argv[2], 10) || 3459;
const UPSTREAM = "https://chat.qwen.ai";
const REQ_TIMEOUT = 60000;
const HEALTH_INTERVAL = 25000;

let browser = null;
let page = null;
let cookieCount = 0;
let healthTimer = null;

function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [waf-proxy]`, ...args);
}

async function findOrCreatePage(port) {
  const browserUrl = `http://127.0.0.1:${port}`;
  browser = await puppeteer.connect({
    browserURL: browserUrl,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  page = pages.find((p) => p.url().includes("chat.qwen.ai"));
  if (!page) {
    page = await browser.newPage();
    await page
      .goto(UPSTREAM, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => {});
  }
  log(`Connected to Chrome on port ${port}`);
}

async function connectBrowser() {
  for (const port of [9222, 9223]) {
    try {
      log(`Trying port ${port}...`);
      await findOrCreatePage(port);
      return;
    } catch (e) {
      log(`Port ${port}: ${e.message}`);
    }
  }
  throw new Error(
    "No running Chrome found with remote debugging on port 9222/9223.\n" +
      "Start Chrome manually: chrome.exe --remote-debugging-port=9222",
  );
}

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) {
    try {
      await page.evaluate(() => true);
      return;
    } catch {}
  }
  log("Browser disconnected, requests will fail until Chrome is restarted");
  browser = null;
  page = null;
}

async function proxyViaBrowser(method, reqPath, headers, body) {
  if (!page || page.isClosed()) {
    throw new Error(
      "Browser not connected. Start Chrome with --remote-debugging-port=9222",
    );
  }
  await ensureBrowser();
  if (!page) throw new Error("Browser disconnected");
  const targetUrl = UPSTREAM + reqPath;
  const h = maskHeaders(headers);
  const result = await page.evaluate(
    async ({ targetUrl, method, h, body, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const opts = {
          method,
          headers: h,
          signal: controller.signal,
          redirect: "follow",
        };
        if (body && method !== "GET" && method !== "HEAD") opts.body = body;
        const res = await fetch(targetUrl, opts);
        const text = await res.text();
        const respHeaders = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });
        return {
          ok: true,
          status: res.status,
          headers: respHeaders,
          body: text,
          statusText: res.statusText,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally {
        clearTimeout(timer);
      }
    },
    { targetUrl, method, h, body, timeout: REQ_TIMEOUT },
  );
  if (!result.ok) throw new Error(result.error || "Browser fetch failed");
  if (result.headers["set-cookie"]) {
    const sc = result.headers["set-cookie"];
    cookieCount = Array.isArray(sc) ? sc.length : sc.split("\n").length;
  }
  return result;
}

function maskHeaders(headers) {
  const allowed = [
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "origin",
    "referer",
    "source",
    "version",
    "bx-v",
    "sec-ch-ua",
    "timezone",
    "accept-language",
    "cookie",
  ];
  const h = {};
  for (const key of Object.keys(headers)) {
    if (allowed.includes(key.toLowerCase())) h[key] = headers[key];
  }
  h["Origin"] = UPSTREAM;
  h["Referer"] = UPSTREAM + "/";
  h["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
  return h;
}

function startHealthCheck() {
  healthTimer = setInterval(async () => {
    if (page && !page.isClosed()) {
      try {
        await page.evaluate(() => true);
      } catch {
        log("Browser page lost");
        page = null;
      }
    }
  }, HEALTH_INTERVAL);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, source, version, bx-v",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const method = req.method;
    const parsed = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`,
    );
    const reqPath = parsed.pathname + parsed.search;

    if (req.url === "/health") {
      const alive = page && !page.isClosed();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          pageAlive: alive,
          cookies: cookieCount,
          browserConnected: !!browser,
        }),
      );
      return;
    }

    if (!reqPath.includes("/api/v2/")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Only /api/v2/* paths are proxied" }));
      return;
    }

    const body =
      chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null;
    log(`${method} ${reqPath}`);

    try {
      const result = await proxyViaBrowser(method, reqPath, req.headers, body);
      const respHeaders = {
        "Content-Type":
          result.headers["content-type"] ||
          result.headers["Content-Type"] ||
          "application/json",
        "Access-Control-Allow-Origin": "*",
      };
      res.writeHead(result.status, respHeaders);
      res.end(result.body);
    } catch (e) {
      log(`Error: ${e.message}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

connectBrowser()
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      log(`Listening on http://127.0.0.1:${PORT}`);
      log(`Upstream: ${UPSTREAM}`);
      startHealthCheck();
      log("Health monitoring active (every 25s)");
    });

    const shutdown = async () => {
      log("Shutting down...");
      if (healthTimer) clearInterval(healthTimer);
      if (browser) {
        try {
          await browser.disconnect();
        } catch {}
      }
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((e) => {
    log(`Failed: ${e.message}`);
    process.exit(1);
  });
