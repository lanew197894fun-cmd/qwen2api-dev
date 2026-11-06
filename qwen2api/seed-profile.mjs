/**
 * seed-profile.mjs - 將有效 cookies 注入 Qwen Chrome profile
 *
 * Qwen 改版後架構：
 *   refresh_token cookie → GET auth.qwen.ai/api/v2/auths/refresh → access_token → localStorage
 *
 * 本腳本把備份 cookies 種回 profile，讓後續 auto-get-token.js 能 headless 自動 refresh。
 * 同時輸出 access token 供寫入 data.json。
 *
 * 用法: node seed-profile.mjs [cookies檔案路徑]
 */
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(DIR, ".chrome-qwen-profile");
const COOKIE_FILE = process.argv[2] || path.join(DIR, ".qwen-cookies.json");
const COOKIE_STORE = path.join(DIR, ".qwen-token.json");

const log = (m) => console.log(m);

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH))
      return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const home = os.homedir();
  const cands = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    path.join(home, ".local/bin/google-chrome"),
    "/app/bin/google-chrome",
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 掃 puppeteer cache
  const root = path.join(home, ".cache/puppeteer/chrome");
  if (fs.existsSync(root)) {
    for (const v of fs
      .readdirSync(root)
      .filter((d) => d.startsWith("linux-"))
      .sort()
      .reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = path.join(root, v, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

const decodeExp = (jwt) => {
  try {
    let s = jwt.split(".")[1];
    // base64url → base64 補丁
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(Buffer.from(s, "base64").toString()).exp;
  } catch {
    return 0;
  }
};

const fmtTs = (ts) =>
  ts ? new Date(ts * 1000).toISOString().replace(".000Z", "Z") : "(無)";

async function main() {
  const chrome = findChrome();
  if (!chrome) return (log("❌ 找不到 Chrome"), process.exit(1));
  log("✅ Chrome:", chrome);

  if (!fs.existsSync(COOKIE_FILE)) {
    return (log("❌ cookies 檔不存在:", COOKIE_FILE), process.exit(1));
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  log(`✅ 載入 ${cookies.length} 個 cookies`);

  // 清掉殘留 Chrome（profile 鎖死會失敗）
  try {
    execSync(`pkill -f '${PROFILE}' 2>/dev/null || true`, {
      stdio: "ignore",
      timeout: 5000,
    });
    await new Promise((r) => setTimeout(r, 2500));
  } catch {}

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: PROFILE,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // 抓 refresh 換到的 token
  let refreshed = null;
  page.on("response", async (res) => {
    if (!res.url().includes("/auths/refresh")) return;
    try {
      const j = JSON.parse(await res.text());
      if (j?.data?.access_token) refreshed = j.data;
    } catch {}
  });

  log("📍 開啟 chat.qwen.ai...");
  await page.goto("https://chat.qwen.ai", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  log("💉 注入 cookies...");
  await page.setCookie(...cookies);

  log("🔄 重新載入觸發 refresh...");
  await page
    .reload({ waitUntil: "networkidle2", timeout: 45000 })
    .catch(() => {});

  // 若前端沒主動 refresh，強制清 token 再重載
  if (!refreshed) {
    log("🔧 主動清 token 強制 refresh...");
    await page.evaluate(() => {
      localStorage.removeItem("token");
      localStorage.removeItem("qwen_access_token_state");
    });
    await page
      .reload({ waitUntil: "networkidle2", timeout: 45000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));
  }

  const token = await page.evaluate(() => localStorage.getItem("token"));
  if (!token) {
    await browser.close();
    return (
      log("❌ refresh 失敗，未取得 access token（refresh_token 可能已失效）"),
      process.exit(1)
    );
  }

  // 讀回 cookie（refresh_token 已被輪替成新的）
  const nowCookies = await page.cookies();
  const rt = nowCookies.find((c) => c.name === "refresh_token");

  log("");
  log("════════════════════════════════════");
  log("🎉 成功取得 access token");
  log("════════════════════════════════════");
  log("access_token  到期:", fmtTs(decodeExp(token)));
  log("refresh_token 到期:", rt ? fmtTs(rt.expirationDate) : "(session)");

  // 存 cookie（已更新）供下次使用
  const merged = {};
  cookies.forEach((c) => (merged[c.name] = c));
  nowCookies.forEach((c) => {
    if (!merged[c.name] || merged[c.name] !== c.value) {
      log(`🔄 cookie 輪替: ${c.name}`);
    }
    merged[c.name] = c;
  });
  fs.writeFileSync(
    COOKIE_STORE,
    JSON.stringify(Object.values(merged), null, 2),
    {
      mode: 0o600,
    },
  );
  log("💾 已更新 cookie 備份:", COOKIE_STORE);

  await browser.close();
  log("");
  log("TOKEN=" + token);
  log("REFRESH_TOKEN=" + (rt ? rt.value : ""));
}

main().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
