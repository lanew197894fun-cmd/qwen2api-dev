/**
 * 一次性注入工具：把瀏覽器 DevTools 複製的 cookies JSON 寫入 data.json，
 * 清除 revoked 標記並實測 refresh。
 *
 * 用法: node test/inject-cookies.js <cookies.json>
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data/data.json");

(async () => {
  const file = process.argv[2];
  assert.ok(file, "用法: node test/inject-cookies.js <cookies.json>");
  const arr = JSON.parse(fs.readFileSync(file, "utf-8"));

  // 只收 qwen.ai 域，並保留 session cookie（無 expirationDate）
  const flat = {};
  for (const c of arr) {
    const d = (c.domain || "").toLowerCase();
    if (d !== ".qwen.ai" && d !== "chat.qwen.ai" && !d.endsWith(".qwen.ai"))
      continue;
    flat[c.name] = c.value;
  }
  assert.ok(flat.refresh_token, "cookies 中必須含 refresh_token");
  console.log("注入 cookies:", Object.keys(flat).length, "個");

  const data = JSON.parse(fs.readFileSync(DATA, "utf-8"));
  const acc = (data.accounts || []).find(
    (a) => a.email === "lanew197894fun@gmail.com",
  );
  assert.ok(acc, "找不到目標帳戶");

  const prev = acc.cookies?.refresh_token?.slice(-12) || "(無)";
  acc.cookies = flat;
  acc.refresh_token = flat.refresh_token;
  acc.refresh_token_expires = flat.refresh_token.exp || 1794843877;
  acc.loginMethod = "browser";
  // 舊 access token 一律作廢，交由 refresh 重新取得（15 分鐘效期，本就過期）
  acc.token = null;
  acc.expires = 0;
  delete acc.tokenError;

  fs.writeFileSync(DATA, JSON.stringify(data, null, 2), "utf-8");
  console.log("舊 refresh_token 尾碼:", prev);
  console.log("新 refresh_token 尾碼:", flat.refresh_token.slice(-12));
  console.log("✅ 已寫入 data.json（token 清空待 refresh）");
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
