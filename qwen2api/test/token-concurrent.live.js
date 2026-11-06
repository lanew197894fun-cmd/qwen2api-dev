/**
 * 真實併發驗證：5 個併發 ensureFreshToken 必須全部拿到 token
 * （修補前：只有 1 個成功，其餘 4 個拿到 null → 「無法取得有效的通路令牌」）
 */
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const TokenManager = require(path.join(__dirname, "../src/utils/token-manager.js"));
const DATA = path.join(__dirname, "../data/data.json");

(async () => {
  const raw = JSON.parse(fs.readFileSync(DATA, "utf-8"));
  const base = raw.accounts.find((a) => a.cookies?.refresh_token);
  assert.ok(base, "需有 browser 帳戶");

  const tm = new TokenManager();
  tm.persistHook = async () => true;

  // 模擬 5 個併發請求共用同一帳戶物件
  const acc = { ...base, cookies: { ...base.cookies }, token: null, expires: 0 };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => tm.ensureFreshToken(acc)),
  );

  const ok = results.filter(Boolean).length;
  console.log("併發 5 次 → 成功:", ok, "/ 5");
  console.log("結果是否一致:", new Set(results.filter(Boolean)).size === 1);
  assert.strictEqual(ok, 5, "所有併發呼叫都必須拿到 token");
  assert.ok(acc.tokenError === null, "不應有 tokenError");

  console.log("\n✅ 併發驗證通過");
})().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
