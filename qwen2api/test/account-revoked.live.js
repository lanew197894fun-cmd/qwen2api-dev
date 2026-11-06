/**
 * 整合驗證：真實 Account 生命週期（處理 _primeBrowserTokens 的併發鎖）
 */
const path = require("path");
const assert = require("assert");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const accountManager = require(path.join(__dirname, "../src/utils/account.js"));
  await accountManager._initPromise;

  const acc = accountManager.accountTokens.find((a) => a.cookies?.refresh_token);
  assert.ok(acc, "需載入 browser 帳戶");
  console.log("帳戶數:", accountManager.accountTokens.length, "| 目標:", acc.email);

  assert.strictEqual(typeof accountManager.tokenManager.persistHook, "function");
  console.log("✅ persistHook 已綁定");

  // 等 _primeBrowserTokens 的背景 refresh 結束
  for (let i = 0; i < 30 && acc._refreshPromise; i++) await wait(1000);
  console.log("背景 refresh 後 tokenError:", JSON.stringify(acc.tokenError));

  // 若尚未偵測（併發鎖短路），補一次
  if (!acc.tokenError) {
    const t = await accountManager.tokenManager.ensureFreshToken(acc);
    console.log("補觸發 refresh:", t ? "成功" : "失敗");
  }
  console.log("最終 tokenError:", JSON.stringify(acc.tokenError));
  assert.ok(acc.tokenError?.revoked, "應偵測到 revoked");

  const avail = accountManager.accountRotator._getAvailableAccounts().map((a) => a.email);
  assert.ok(!avail.includes(acc.email), "revoked 帳戶應被排除");
  console.log("✅ revoked 帳戶已被輪詢器排除（可用:", JSON.stringify(avail), "）");

  const stats = accountManager.accountRotator.getStats();
  console.log("stats.tokenError:", JSON.stringify(stats.usageStats[acc.email]?.tokenError));

  // 30 分鐘冷卻內不重試
  accountManager._ensureTokenAsync(acc);
  console.log("冷卻期內 _ensureTokenAsync 是否觸發:", acc._refreshPromise === true);

  const fs = require("fs");
  const disk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/data.json"), "utf-8"),
  ).accounts.find((a) => a.email === acc.email);
  console.log("磁碟 token:", disk.token === null ? "已清空 ✅" : disk.token?.slice(0, 20));
  console.log("磁碟 cookies 保留:", !!disk.cookies?.refresh_token ? "✅" : "❌");
  assert.ok(disk.cookies?.refresh_token, "cookies 不應被清空");

  console.log("\n✅ 整合驗證通過");
  process.exit(0);
})().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
