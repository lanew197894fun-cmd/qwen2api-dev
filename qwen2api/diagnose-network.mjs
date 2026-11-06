#!/usr/bin/env bun
/**
 * 診斷腳本：分析 chat.qwen.ai 前端網路請求和認證機制
 *
 * 用途：
 *   1. 攔截所有網路請求與回應，觀察真實前端如何通過 WAF
 *   2. 檢查 localStorage token 狀態
 *   3. 記錄 API 呼叫的 headers、payload、response
 *   4. 找出真實前端與 browser-proxy 的差異
 */

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_FILE = path.resolve(
  import.meta.dirname,
  "logs",
  "diagnose-network.log",
);
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

// Track request/response pairs
const requestMap = new Map();
let apiCalls = [];
let wafChallenges = [];

async function main() {
  log("=== 開始診斷 chat.qwen.ai 網路請求 ===\n");
  log(`Chrome: ${CHROME_PATH}`);
  log(`Profile: ${PROFILE_DIR}`);

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

  log(`\n瀏覽器版本: ${await browser.version()}`);

  const page = await browser.newPage();

  // Intercept ALL requests
  const allRequests = [];
  const allResponses = new Map();

  page.on("request", (req) => {
    allRequests.push({
      id: req._requestId || req.url(),
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData: req.postData(),
      resourceType: req.resourceType(),
    });
  });

  page.on("response", async (res) => {
    const url = res.url();
    const status = res.status();
    const headers = res.headers();

    // Only log API calls
    if (url.includes("/api/")) {
      let body = null;
      const ct = headers["content-type"] || "";
      try {
        if (ct.includes("json")) {
          body = await res.json().catch(() => null);
        } else if (ct.includes("text")) {
          body = (await res.text().catch(() => "")).substring(0, 2000);
        }
      } catch {}

      const entry = { url, status, headers, body };
      allResponses.set(url, entry);

      const isWaf =
        status === 412 ||
        status === 302 ||
        (typeof body === "string" &&
          (body.includes("aliyun_waf") || body.includes("acw_")));

      if (isWaf) {
        wafChallenges.push({
          url,
          status,
          body:
            typeof body === "string"
              ? body.substring(0, 500)
              : JSON.stringify(body).substring(0, 500),
        });
      }

      log(`\n📡 ${res.request().method()} ${status} ${url}`);
      if (isWaf) log(`   ⚠️  WAF CHALLENGE DETECTED`);
      if (body && typeof body === "object") {
        const bodyStr = JSON.stringify(body).substring(0, 1000);
        log(`   Body: ${bodyStr}`);
      }
    }
  });

  page.on("requestfailed", (req) => {
    log(
      `\n❌ FAILED ${req.method()} ${req.url()}: ${req.failure()?.errorText}`,
    );
  });

  // ▸ Phase 1: Navigate and wait for page to load
  log("\n▸ Phase 1: 導航到 chat.qwen.ai");
  try {
    await page.goto("https://chat.qwen.ai", {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
  } catch (e) {
    log(`導航: ${e.message}`);
  }

  await new Promise((r) => setTimeout(r, 3000));
  log(`\n當前 URL: ${page.url()}`);
  log(`頁面標題: ${await page.title().catch(() => "N/A")}`);

  // ▸ Phase 2: Check localStorage
  log("\n▸ Phase 2: 檢查 localStorage");
  const lsData = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const result = {};
    for (const k of keys) {
      const val = localStorage.getItem(k);
      // Truncate long values
      result[k] =
        typeof val === "string" && val.length > 200
          ? val.substring(0, 100) + "..." + val.substring(val.length - 50)
          : val;
    }
    return result;
  });
  log(`localStorage keys: ${Object.keys(lsData).join(", ")}`);
  for (const [k, v] of Object.entries(lsData)) {
    if (k === "token" && v) {
      try {
        const payload = JSON.parse(
          Buffer.from(v.split(".")[1], "base64url").toString(),
        );
        log(`   token: ${v.substring(0, 30)}...`);
        log(`   token exp: ${new Date(payload.exp * 1000).toISOString()}`);
        log(`   token payload: ${JSON.stringify(payload)}`);
      } catch {
        log(`   token: ${v}`);
      }
    } else {
      log(`   ${k}: ${v}`);
    }
  }

  // ▸ Phase 3: Check cookies
  log("\n▸ Phase 3: 檢查 cookies");
  const cookies = await page.cookies();
  for (const c of cookies) {
    log(
      `   ${c.name}: ${c.value.substring(0, 50)}... (domain: ${c.domain}, path: ${c.path})`,
    );
  }

  // ▸ Phase 4: Check DOM for login state
  log("\n▸ Phase 4: 檢查 DOM 登入狀態");
  const loginState = await page.evaluate(() => {
    const body = document.body?.innerText?.substring(0, 500) || "N/A";
    // Check for common login indicators
    const hasLoginBtn = !!document.querySelector('[data-testid="login"]');
    const hasUserMenu = !!document.querySelector('[data-testid="user-menu"]');
    const hasAvatar = !!document.querySelector('[class*="avatar"]');
    return { bodySnippet: body, hasLoginBtn, hasUserMenu, hasAvatar };
  });
  log(
    `   DOM login check: loginBtn=${loginState.hasLoginBtn} userMenu=${loginState.hasUserMenu} avatar=${loginState.hasAvatar}`,
  );
  log(`   Body: ${loginState.bodySnippet}`);

  // ▸ Phase 5: Try a GET API call from browser
  log("\n▸ Phase 5: 從瀏覽器內 fetch API 模型列表");
  try {
    const token = await page.evaluate(() => localStorage.getItem("token"));
    const getResult = await page.evaluate(async (tok) => {
      try {
        const r = await fetch("https://chat.qwen.ai/api/models", {
          headers: {
            Authorization: tok ? `Bearer ${tok}` : "",
            Accept: "application/json",
          },
          credentials: "include",
        });
        const ct = r.headers.get("content-type") || "";
        const body = ct.includes("json")
          ? JSON.stringify(await r.json())
          : await r.text();
        return {
          status: r.status,
          contentType: ct,
          body: body.substring(0, 2000),
        };
      } catch (e) {
        return { status: 0, body: e.message, error: true };
      }
    }, token);
    log(`   GET /api/models → ${getResult.status}`);
    if (!getResult.error && getResult.status < 400) {
      log(`   ✅ GET 通過 WAF!`);
      log(`   Body: ${getResult.body.substring(0, 500)}`);
    } else {
      log(`   ⚠️  結果: ${getResult.body.substring(0, 300)}`);
    }
  } catch (e) {
    log(`   ❌ Error: ${e.message}`);
  }

  // ▸ Phase 6: Try a POST API call from browser
  log("\n▸ Phase 6: 從瀏覽器內 fetch POST /api/v2/chats/new");
  try {
    const token = await page.evaluate(() => localStorage.getItem("token"));
    const postResult = await page.evaluate(async (tok) => {
      try {
        const r = await fetch("https://chat.qwen.ai/api/v2/chats/new", {
          method: "POST",
          headers: {
            Authorization: tok ? `Bearer ${tok}` : "",
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: "https://chat.qwen.ai",
            Referer: "https://chat.qwen.ai/c/guest",
          },
          credentials: "include",
          body: JSON.stringify({
            title: "Diagnostic Chat",
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
          contentType: ct,
          body: body.substring(0, 2000),
          headers: Object.fromEntries(r.headers.entries()),
        };
      } catch (e) {
        return { status: 0, body: e.message, error: true };
      }
    }, token);
    log(`   POST /api/v2/chats/new → ${postResult.status}`);
    log(`   Content-Type: ${postResult.contentType}`);
    if (!postResult.error) {
      const isWaf =
        postResult.body.includes("aliyun_waf") ||
        postResult.body.includes("acw_");
      if (isWaf) {
        log(`   ⚠️  WAF CHALLENGE detected! 瀏覽器 fetch 仍被擋`);
        log(`   WAF body (first 500): ${postResult.body.substring(0, 500)}`);
      } else if (postResult.status === 200) {
        log(`   ✅ POST 通過 WAF!`);
        log(`   Response: ${postResult.body.substring(0, 500)}`);
      } else {
        log(`   Status: ${postResult.status}`);
        log(`   Body: ${postResult.body.substring(0, 500)}`);
      }
    } else {
      log(`   ❌ Error: ${postResult.body}`);
    }
  } catch (e) {
    log(`   ❌ Error: ${e.message}`);
  }

  // ▸ Phase 7: Now try navigating to an actual page within chat.qwen.ai that makes POST calls
  // This is the KEY experiment: the real frontend's JS should handle WAF natively
  log("\n▸ Phase 7: 導航到聊天頁面讓前端 JS 處理 POST");
  try {
    await page.goto("https://chat.qwen.ai/c/guest", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    log(`   導航成功: ${page.url()}`);
    await new Promise((r) => setTimeout(r, 5000));

    // Check if the page made any POST API calls that succeeded
    // by looking at what loaded
    log(`   頁面標題: ${await page.title().catch(() => "N/A")}`);
    const pageText = await page.evaluate(
      () => document.body?.innerText?.substring(0, 1000) || "N/A",
    );
    log(`   頁面內容: ${pageText}`);
  } catch (e) {
    log(`   導航失敗: ${e.message}`);
  }

  // ▸ Summary
  log("\n\n=== 診斷摘要 ===\n");
  log(
    `API 請求總數: ${allRequests.filter((r) => r.url.includes("/api/")).length}`,
  );
  log(`WAF 挑戰次數: ${wafChallenges.length}`);
  log(`成功的 GET: ${allResponses.size}`);
  log(`localStorage token: ${lsData.token ? "✅ 存在" : "❌ 不存在"}`);

  // Log all API URLs
  log("\n所有 API 請求:");
  const apiReqs = allRequests.filter((r) => r.url.includes("/api/"));
  for (const req of apiReqs) {
    log(`  ${req.method} ${req.url}`);
  }

  log("\n=== 診斷結束 ===\n");

  await browser.close();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  console.error(e);
  process.exit(1);
});
