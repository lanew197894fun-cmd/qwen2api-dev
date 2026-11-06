import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(DIR, "data/data.json");
const TOKENS = path.join(DIR, ".qwen-token.json");

const cookies = JSON.parse(fs.readFileSync(TOKENS, "utf-8"));
const rt = cookies.find((c) => c.name === "refresh_token");
const cna = cookies.find((c) => c.name === "cna");

if (!rt) {
  console.error("❌ .qwen-token.json 內無 refresh_token");
  process.exit(1);
}

const jwtExp = (jwt) => {
  try {
    let s = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(Buffer.from(s, "base64").toString()).exp || 0;
  } catch {
    return 0;
  }
};

// puppeteer 回傳的 expires 可能為 -1（session），以 JWT payload 的 exp 為準
const rtExp = rt.expirationDate > 0 ? rt.expirationDate : jwtExp(rt.value);

// 組出 cookie 字串（給 defaultCookie 用）
const flat = {};
cookies.forEach((c) => (flat[c.name] = c.value));
const cookieStr = Object.entries(flat)
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

const data = JSON.parse(fs.readFileSync(DATA, "utf-8"));
const email = "lanew197894fun@gmail.com";
let acc = data.accounts.find((a) => a.email === email);

if (!acc) {
  acc = { email, password: "", stats: {}, statsHistory: {} };
  data.accounts.push(acc);
}

// 標記為 browser 登入，避免嘗試 password 登入（Qwen 已拒絕）
acc.loginMethod = "browser";
acc.password = acc.password || "";
acc.cookies = flat;
acc.refresh_token = rt.value;
acc.refresh_token_expires = rtExp;
if (cna) acc.cna = cna.value;
delete acc.token;
delete acc.expires;

data.defaultCookie = cookieStr;
data.defaultHeaders = data.defaultHeaders || null;

fs.writeFileSync(DATA, JSON.stringify(data, null, 2), { mode: 0o600 });

console.log("✅ data.json 已更新");
console.log("   帳戶:", email);
console.log("   模式: browser (cookie refresh)");
console.log("   refresh_token 到期:", new Date(rtExp * 1000).toISOString());
console.log("   cookie 數:", Object.keys(flat).length);
console.log("   帳戶總數:", data.accounts.length);
