#!/usr/bin/env bun
// .env 加密工具 — 將敏感欄位（TELEGRAM_BOT_TOKEN, API_KEY）加密為 ~ENC~ 格式
// 用法: bun tools/encrypt-env.ts
// 前置: ~/.opencode/encryption.key 必須存在（執行 bun tools/generate-key.ts）

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 從 ~/.opencode/encryption.key 載入金鑰（若環境變數未設定）
if (!process.env.ENCRYPTION_KEY) {
  const keyPath = join(homedir(), ".opencode", "encryption.key");
  if (existsSync(keyPath)) {
    process.env.ENCRYPTION_KEY = readFileSync(keyPath, "utf-8").trim();
  }
}

// 載入 encrypt
const __dirname = dirname(fileURLToPath(import.meta.url));
const encPath = resolve(__dirname, "../src/encryption.ts");

// 動態載入 encryption 模組
const { encrypt, hasKey } = await import(encPath);

// 檢查金鑰
if (!hasKey()) {
  const keyPath = join(homedir(), ".opencode", "encryption.key");
  console.error("❌ 加密金鑰不存在");
  console.error(`   請先執行: bun tools/generate-key.ts`);
  console.error(`   或設定 ENCRYPTION_KEY 環境變數`);
  process.exit(1);
}

// 需要加密的欄位清單
const SENSITIVE = new Set(["TELEGRAM_BOT_TOKEN", "API_KEY"]);

// 讀取 .env
const envPath = resolve(__dirname, "../.env");
if (!existsSync(envPath)) {
  console.error("❌ 找不到 .env 檔案");
  console.error(`   預期路徑: ${envPath}`);
  process.exit(1);
}

const raw = readFileSync(envPath, "utf-8");
const lines = raw.split("\n");
const out: string[] = [];
let changed = 0;

for (const line of lines) {
  const trimmed = line.trim();
  // 保留註解與空行
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

  if (SENSITIVE.has(key)) {
    if (val.startsWith("~ENC~")) {
      out.push(line); // 已加密，保留
    } else if (val) {
      out.push(`${key}=${encrypt(val)}`);
      changed++;
    } else {
      out.push(line); // 空值，保留
    }
  } else {
    out.push(line); // 非敏感欄位，保留
  }
}

if (changed === 0) {
  console.log("✅ 所有敏感欄位已加密，無需變更");
  process.exit(0);
}

// 寫回 .env
writeFileSync(envPath, out.join("\n"), "utf-8");
console.log(`✅ 已加密 ${changed} 個敏感欄位`);
console.log(`   📄 ${envPath}`);
console.log("");
console.log("   原始 .env 已自動覆寫");
console.log("   若需恢復，請從版本控制還原");
