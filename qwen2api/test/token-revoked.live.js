/**
 * 真實端點驗證（不 mock）：以 data.json 實際 cookies 打 auth.qwen.ai
 * 確認 revoked 診斷路徑在真實回應下正確運作，且不會噴「未回傳 access_token」
 */
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const TokenManager = require(path.join(__dirname, "../src/utils/token-manager.js"));
const DATA = path.join(__dirname, "../data/data.json");

(async () => {
  const accounts = JSON.parse(fs.readFileSync(DATA, "utf-8")).accounts || [];
  const acc = accounts.find((a) => a.cookies?.refresh_token);
  assert.ok(acc, "需有帶 refresh_token 的 browser 帳戶");

  const tm = new TokenManager();
  const saved = [];
  tm.persistHook = async (email, patch) => {
    saved.push(patch);
    return true;
  };

  const target = { ...acc, cookies: { ...acc.cookies } };
  const token = await tm.ensureFreshToken(target);

  console.log("實測結果:");
  console.log("  email          :", acc.email);
  console.log("  refresh_token  :", acc.cookies.refresh_token.slice(0, 24) + "...");
  console.log("  回傳 token     :", token ? token.slice(0, 24) + "..." : "(無)");
  console.log("  tokenError     :", JSON.stringify(target.tokenError));

  if (target.tokenError?.revoked) {
    // 撤銷情境：應有清空 token 的落盤動作
    assert.ok(
      saved.some((p) => p.token === null),
      "revoked 時應落盤清空 token",
    );
    console.log("  落盤動作       :", JSON.stringify(saved));
    console.log("\n✅ 已正確辨識 TOKEN_REVOKED（非籠統的 access_token 遺失）");
    console.log("   → 需重新登入：node auto-get-token.js");
  } else if (token) {
    console.log("\n✅ refresh 成功，token 已取得並落盤:", JSON.stringify(saved));
  } else {
    console.log("\n⚠️  refresh 失敗:", JSON.stringify(target.tokenError));
  }
})().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
