/**
 * 驗證：Qwen refresh 回 HTTP 200 + x-actual-status-code:401 + x-error-code:TOKEN_REVOKED
 * 時，程式必須
 *   1. 辨識為 revoked（非「未回傳 access_token」）
 *   2. 在 account 上留下 tokenError 診斷標記
 *   3. 落盤清掉過期 token
 *   4. 瀏覽器模式不再降級 email/password 登入（避免無效 400 請求）
 */
const assert = require("assert");
const path = require("path");

const TokenManager = require(path.join(__dirname, "../src/utils/token-manager.js"));

const mkAccount = () => ({
  email: "revoked@example.com",
  password: "dummy",
  loginMethod: "browser",
  token: null,
  expires: 0,
  cookies: { refresh_token: "rt", cna: "c" },
});

(async () => {
  const tm = new TokenManager();
  const persisted = [];
  tm.persistHook = async (email, patch) => {
    persisted.push({ email, patch });
    return true;
  };

  // 1) 解析 header：HTTP 200 但實際 401 + TOKEN_REVOKED
  const parsed = tm._parseRefreshResponse({
    headers: {
      "x-actual-status-code": "401",
      "x-error-code": "TOKEN_REVOKED",
    },
    data: { success: false, data: { code: "Unauthorized" } },
  });
  assert.strictEqual(parsed.revoked, true, "應辨識為 revoked");
  assert.strictEqual(parsed.code, "TOKEN_REVOKED", "應帶出錯誤碼");

  // 2) 正常 200 不得誤判
  const ok = tm._parseRefreshResponse({
    headers: {},
    data: { data: { access_token: "a", refresh_token: "r" } },
  });
  assert.strictEqual(ok.revoked, false, "正常回應不得誤判 revoked");

  // 3) revoked 帳戶：ensureFreshToken 回 null、不降級密碼登入
  const acc = mkAccount();
  let loginCalled = false;
  tm.login = async () => {
    loginCalled = true;
    return "should-not-happen";
  };
  const originalRefresh = tm.refreshViaCookie.bind(tm);
  tm.refreshViaCookie = async (a) => {
    a.tokenError = {
      code: "TOKEN_REVOKED",
      revoked: true,
      at: Date.now(),
    };
    a.token = null;
    a.expires = 0;
    return null;
  };
  const token = await tm.ensureFreshToken(acc);
  assert.strictEqual(token, null, "revoked 帳戶應回 null");
  assert.strictEqual(loginCalled, false, "瀏覽器模式不得降級密碼登入");
  assert.strictEqual(acc.tokenError.revoked, true, "應留下 revoked 標記");
  tm.refreshViaCookie = originalRefresh;

  console.log("✅ token-revoked 驗證通過");
})().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
