#!/usr/bin/env bun
// 產生 AES-256-GCM 加密金鑰（64 hex chars = 32 bytes）
// 用法: bun tools/generate-key.ts
// 輸出: 金鑰字串 + 自動存到 ~/.opencode/encryption.key

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const key = randomBytes(32).toString("hex");

const dir = join(homedir(), ".opencode");
const path = join(dir, "encryption.key");

if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(path, key, "utf-8");

console.log("✅ AES-256-GCM 金鑰已產生");
console.log(`   📄 ${path}`);
console.log("");
console.log(`   金鑰: ${key}`);
console.log("");
console.log("   已自動儲存，bridge 啟動時會自動讀取");
console.log("   建議備份此金鑰到安全處");
