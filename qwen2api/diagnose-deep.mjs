#!/usr/bin/env bun
/**
 * 深入診斷：擷取真實前端 POST 請求的完整 headers + 分析 WAF 行為
 *
 * 目標：
 *   1. 擷取真實前端成功 POST 的完整 headers（/api/v2/users/status）
 *   2. 擷取 WAF challenge 回應的完整 HTML
 *   3. 嘗試在執行 WAF challenge JS 後重試
 *   4. 分析頁面中是否有 CSRF token 或其他安全機制
 */

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_FILE = path.resolve(import.meta.dirname, "logs", "diagnose-deep.log");
const PROFILE_DIR = path.resolve(import.meta.dirname, ".chrome-qwen-profile");
const CHROME_PATH =
  process.env.CHROME_PATH ||
  (() => {
    // 動態尋找 Puppeteer Chrome（不硬編碼使用者名稱）
    const cacheDir = path.join(os.homedir(), ".cache/puppeteer/chrome");
    try {
      const versions = fs.readdirSync(cacheDir).filter((d) => d.startsWith("linux-")).sort().reverse();
      if (versions.length) {
        const chromeBin = path.join(cacheDir, versions[0], "chrome-linux64/chrome");
        if (fs.existsSync(chromeBin)) return chromeBin;
      }
    } catch {}
    return path.join(cacheDir, "chrome-linux64/chrome"); // fallback
  })();

const log = (msg) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
};

async function captureRealRequests(page) {
  /** Capture the REAL frontend's request details */
  const captured = [];

  // Override fetch to capture request details BEFORE sending
  await page.evaluate(() => {
    const origFetch = window.fetch;
    window.__capturedRequests = [];
    window.fetch = async (...args) => {
      const url = typeof args[0] === "string" ? args[0] : args[0].url;
      const opts = args[1] || {};
      window.__capturedRequests.push({
        url,
        method: opts.method || "GET",
        headers: { ...(opts.headers || {}) },
        body: opts.body ? opts.body.substring(0, 500) : null,
        ts: Date.now(),
      });
      return origFetch(...args);
    };
  });
}

async function main() {
  log("=== 深入診斷：分析真實前端 POST 請求 ===\n");
  log(`Chrome: ${CHROME_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const page = await browser.newPage();

  // Collect real network requests with FULL details
  const realRequests = [];

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("/api/")) return;

    realRequests.push({
      url,
      method: req.method(),
      headers: req.headers(),
      postData: req.postData(),
      resourceType: req.resourceType(),
      ts: Date.now(),
    });
  });

  // Phase 1: Navigate and let the real page load (capture all requests)
  log("\n▸ Phase 1: 導航到 chat.qwen.ai，捕捉真實前端請求");
  await page
    .goto("https://chat.qwen.ai", {
      waitUntil: "networkidle0",
      timeout: 45000,
    })
    .catch((e) => log(`導航: ${e.message}`));

  await new Promise((r) => setTimeout(r, 3000));

  log(`\n頁面 URL: ${page.url()}`);

  // Log all captured requests with COMPLETE headers
  log("\n── 真實前端 API 請求列表 ──");
  for (const r of realRequests) {
    log(`\n${r.method} ${r.url}`);
    log(`   Headers:`);
    for (const [k, v] of Object.entries(r.headers)) {
      if (k === "cookie" || k === "authorization") {
        log(`     ${k}: ${v.substring(0, 40)}...`);
      } else {
        log(`     ${k}: ${v}`);
      }
    }
    if (r.postData) {
      log(`   Body: ${r.postData.substring(0, 500)}`);
    }
  }

  // Phase 2: Check for CSRF/security tokens in the page
  log("\n▸ Phase 2: 檢查頁面中的安全 token/CSRF 機制");
  const pageTokens = await page.evaluate(() => {
    const metaTokens = [];
    document
      .querySelectorAll(
        'meta[name^="csrf"], meta[name^="x-"], meta[http-equiv]',
      )
      .forEach((el) => {
        metaTokens.push({
          name: el.getAttribute("name"),
          content: el.getAttribute("content")?.substring(0, 100),
        });
      });

    // Check for global variables related to auth
    const globals = [];
    const win = window;
    for (const key of Object.getOwnPropertyNames(win)) {
      if (
        key.toLowerCase().includes("csrf") ||
        key.toLowerCase().includes("token") ||
        key.toLowerCase().includes("auth")
      ) {
        globals.push(key);
      }
    }

    // Check __NEXT_DATA__ or similar React data
    const appState = document
      .getElementById("__NEXT_DATA__")
      ?.textContent?.substring(0, 500);
    const rootProps = document
      .getElementById("root")
      ?.getAttribute("data-props")
      ?.substring(0, 500);

    return { metaTokens, globals, appState, rootProps };
  });

  log(`   Meta tokens: ${JSON.stringify(pageTokens.metaTokens)}`);
  log(`   Auth globals: ${pageTokens.globals.join(", ")}`);
  if (pageTokens.appState)
    log(`   App state: ${pageTokens.appState.substring(0, 300)}`);

  // Phase 3: Try POST with exact same headers as real frontend
  log("\n▸ Phase 3: 模擬真實前端的 POST headers 重試 /api/v2/chats/new");

  // Find the headers the real frontend used for its POST
  const postReq = realRequests.find(
    (r) => r.method === "POST" && r.url.includes("/api/v2/users/status"),
  );

  if (postReq) {
    log(`   使用真實前端的 headers 來發送 POST (來自 ${postReq.url})`);

    // Extract key headers (skip cookie since browser handles it)
    const keyHeaders = {};
    for (const [k, v] of Object.entries(postReq.headers)) {
      const lk = k.toLowerCase();
      if (
        ![
          "host",
          "content-length",
          "cookie",
          "connection",
          "keep-alive",
          "accept-encoding",
          "transfer-encoding",
        ].includes(lk)
      ) {
        keyHeaders[k] = v;
      }
    }

    log(`   複製的 headers: ${JSON.stringify(keyHeaders, null, 2)}`);

    // Now try the POST with these headers
    const token = await page.evaluate(() => localStorage.getItem("token"));
    keyHeaders["authorization"] = `Bearer ${token}`;
    keyHeaders["content-type"] = "application/json";

    const result = await page.evaluate(async (headers) => {
      try {
        const r = await fetch("https://chat.qwen.ai/api/v2/chats/new", {
          method: "POST",
          headers: headers,
          credentials: "include",
          body: JSON.stringify({
            title: "Diag Chat",
            models: ["qwen3.7-max"],
            chat_mode: "local",
            chat_type: "t2i",
            timestamp: Date.now(),
          }),
        });
        const ct = r.headers.get("content-type") || "";
        const body = ct.includes("json")
          ? JSON.stringify(await r.json())
          : await r.text();
        return {
          status: r.status,
          ct,
          headers: Object.fromEntries(r.headers.entries()),
          body: body.substring(0, 3000),
          isWaf:
            !ct.includes("json") ||
            body.includes("aliyun_waf") ||
            body.includes("acw_tc"),
        };
      } catch (e) {
        return { status: 0, body: e.message, error: true };
      }
    }, keyHeaders);

    log(`\n   結果: HTTP ${result.status}`);
    log(`   Content-Type: ${result.ct}`);
    log(`   Is WAF: ${result.isWaf}`);
    if (result.isWaf) {
      log(`   WAF Body (first 2000): ${result.body.substring(0, 2000)}`);
      log(`   Response headers: ${JSON.stringify(result.headers)}`);

      // Phase 4: Try to solve the WAF challenge
      log("\n▸ Phase 4: 嘗試執行 WAF challenge JS");
      if (result.body.includes("<script") || result.body.includes("acw_")) {
        // Set the page content to the WAF challenge HTML
        try {
          await page.setContent(result.body);
          log("   WAF challenge HTML 已設定為頁面內容，等待 JS 執行...");

          // Wait for the challenge JS to execute (it might redirect or set cookies)
          await new Promise((r) => setTimeout(r, 5000));

          // Check cookies
          const cookies = await page.cookies();
          const wafCookie = cookies.find((c) => c.name.includes("acw"));
          if (wafCookie) {
            log(
              `   ✅ WAF cookie set: ${wafCookie.name}=${wafCookie.value.substring(0, 30)}...`,
            );
          } else {
            log(`   ⚠️ WAF cookie not found after setContent`);
            log(`   Current URL: ${page.url()}`);
            // Check if page navigated
            const pageText = await page
              .evaluate(() => document.body?.innerText?.substring(0, 500))
              .catch(() => "N/A");
            log(`   Page text: ${pageText}`);
          }

          // Retry the POST now that WAF might be solved
          log("   重試 POST /api/v2/chats/new...");
          const retryResult = await page.evaluate(async (headers) => {
            try {
              const r = await fetch("https://chat.qwen.ai/api/v2/chats/new", {
                method: "POST",
                headers: headers,
                credentials: "include",
                body: JSON.stringify({
                  title: "Diag Chat Retry",
                  models: ["qwen3.7-max"],
                  chat_mode: "local",
                  chat_type: "t2i",
                  timestamp: Date.now(),
                }),
              });
              const ct = r.headers.get("content-type") || "";
              const body = ct.includes("json")
                ? JSON.stringify(await r.json())
                : await r.text();
              return {
                status: r.status,
                ct,
                headers: Object.fromEntries(r.headers.entries()),
                body: body.substring(0, 2000),
                isWaf: !ct.includes("json") || body.includes("aliyun_waf"),
              };
            } catch (e) {
              return { status: 0, body: e.message, error: true };
            }
          }, headers);

          log(`   重試結果: HTTP ${retryResult.status}`);
          log(`   Content-Type: ${retryResult.ct}`);
          if (retryResult.isWaf) {
            log(`   ⚠️ 仍然被 WAF 阻擋`);
          } else if (retryResult.status === 200) {
            log(
              `   ✅ POST 通過 WAF! 回應: ${retryResult.body.substring(0, 500)}`,
            );
          } else {
            log(`   回應: ${retryResult.body.substring(0, 500)}`);
          }
        } catch (e) {
          log(`   ❌ setContent 錯誤: ${e.message}`);
        }
      }
    } else if (result.status === 200) {
      log(`   ✅ POST 通過 WAF! 回應: ${result.body.substring(0, 500)}`);
    } else {
      log(`   回應: ${result.body.substring(0, 500)}`);
    }
  } else {
    log("   ⚠️ 找不到真實前端的 POST 請求記錄");
  }

  // Phase 5: Check navigator.webdriver and other bot detection signals
  log("\n▸ Phase 5: 檢查 bot 偵測訊號");
  const botSignals = await page.evaluate(() => {
    return {
      webdriver: navigator.webdriver,
      plugins: navigator.plugins.length,
      languages: navigator.languages,
      chrome: window.chrome,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
    };
  });
  log(`   webdriver: ${botSignals.webdriver}`);
  log(`   plugins: ${botSignals.plugins}`);
  log(`   languages: ${botSignals.languages}`);
  log(`   chrome obj: ${!!botSignals.chrome}`);
  log(`   hardwareConcurrency: ${botSignals.hardwareConcurrency}`);
  log(`   deviceMemory: ${botSignals.deviceMemory}`);
  log(`   userAgent: ${botSignals.userAgent}`);

  // Phase 6: Check if there's a WebSocket connection
  log("\n▸ Phase 6: 檢查 WebSocket 或其他傳輸方式");
  const wsInfo = await page.evaluate(() => {
    // Check if the page uses WebSocket
    const origWS = window.WebSocket;
    return { hasWebSocket: typeof origWS === "function" };
  });
  log(`   WebSocket available: ${wsInfo.hasWebSocket}`);

  // Check for service workers
  const swInfo = await page.evaluate(async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs
        .map((r) => r.active?.scriptURL || r.installing?.scriptURL)
        .filter(Boolean);
    } catch {
      return [];
    }
  });
  log(`   Service Workers: ${swInfo.length ? swInfo.join(", ") : "none"}`);

  log("\n=== 深入診斷結束 ===");

  await browser.close();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  console.error(e);
  process.exit(1);
});
