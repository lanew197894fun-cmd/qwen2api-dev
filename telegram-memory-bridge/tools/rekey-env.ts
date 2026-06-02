#!/usr/bin/env bun
// rekey-env.ts — 用舊金鑰解密 .env，再用新金鑰重新加密
// 用法: OLD_KEY=<hex> bun tools/rekey-env.ts
// 前置: ~/.opencode/encryption.key 已更新為新金鑰

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 載入 encryption 模組（用舊金鑰）
const oldKey = process.env.OLD_KEY || "";
if (!oldKey) {
  console.error("❌ 請設定 OLD_KEY 環境變數為舊金鑰 hex");
  process.exit(1);
}
process.env.ENCRYPTION_KEY = oldKey;

const encPath = resolve(__dirname, "../src/encryption.ts");
const { decrypt, encrypt, hasKey } = await import(encPath);

if (!hasKey()) {
  console.error("❌ 舊金鑰無效");
  process.exit(1);
}

// 讀取 .env
const envPath = resolve(__dirname, "../.env");
const raw = readFileSync(envPath, "utf-8");
const lines = raw.split("\n");
const out: string[] = [];

// 先用舊金鑰解密所有 ~ENC~ 值
const decrypted: string[] = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    decrypted.push(line);
    continue;
  }
  const match = trimmed.match(/^([^=]+)=(.*)$/);
  if (!match) {
    decrypted.push(line);
    continue;
  }
  const key = match[1].trim();
  let val = match[2].trim();
  if (val.startsWith("~ENC~")) {
    const plain = decrypt(val);
    if (plain === val) {
      console.warn(`⚠️  ${key}: 解密失敗（可能金鑰不符），保留原值`);
    } else {
      console.log(`🔓 ${key}: 已解密`);
      val = plain;
    }
  }
  decrypted.push(`${key}=${val}`);
}

// 切換到新金鑰（~/.opencode/encryption.key 已更新）
delete process.env.ENCRYPTION_KEY;
const keyPath = join(homedir(), ".opencode", "encryption.key");
if (existsSync(keyPath)) {
  process.env.ENCRYPTION_KEY = readFileSync(keyPath, "utf-8").trim();
}

const { encrypt: encNew, hasKey: hasNew } = await import(encPath);
if (!hasNew()) {
  console.error("❌ 新金鑰無效");
  process.exit(1);
}

// 重新加密敏感欄位
const SENSITIVE = new Set(["TELEGRAM_BOT_TOKEN", "API_KEY"]);
let changed = 0;

for (const line of decrypted) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    out.push(line);
    continue;
  }
  const match = trimmed.match(/^([^=]+)=(.*)$/);
  if (!match) {
    out.push(line);
    continue;
  }
  const key = match[1].trim();
  const val = match[2].trim();

  if (SENSITIVE.has(key) && val && !val.startsWith("~ENC~")) {
    out.push(`${key}=${encNew(val)}`);
    changed++;
  } else {
    out.push(line);
  }
}

writeFileSync(envPath, out.join("\n"), "utf-8");
console.log(`✅ 已重新加密 ${changed} 個欄位（${envPath}）`);
