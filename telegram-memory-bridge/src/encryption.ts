/// <reference types="bun" />
// AES-256-GCM 加解密模組
// 與 qwen2api 的 encryption.js 相容

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const PREFIX = "~ENC~";

let _key: Buffer | null = null;

function getKey(): Buffer | null {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    _key = Buffer.from(raw, "hex");
  } else {
    _key = Buffer.from(raw, "base64");
    if (_key.length !== KEY_LEN) {
      console.warn(
        `[encryption] ENCRYPTION_KEY 解碼後長度 ${_key.length}，預期 ${KEY_LEN}，停用加密`,
      );
      _key = null;
    }
  }
  return _key;
}

/** 加密字串，回傳 ~ENC~{...} 格式。無金鑰時回傳原文（回溯相容） */
export function encrypt(pt: string): string {
  const key = getKey();
  if (!key) return pt;
  if (!pt || pt.startsWith(PREFIX)) return pt;
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALGO, key, iv);
  let enc = c.update(pt, "utf8", "base64");
  enc += c.final("base64");
  const tag = c.getAuthTag().toString("base64");
  return PREFIX + JSON.stringify({ e: enc, i: iv.toString("base64"), t: tag });
}

/** 解密 ~ENC~ 字串。非加密格式或無金鑰時回傳原文 */
export function decrypt(ct: string): string {
  const key = getKey();
  if (!key) return ct;
  if (!ct || typeof ct !== "string" || !ct.startsWith(PREFIX)) return ct;
  try {
    const { e, i, t } = JSON.parse(ct.slice(PREFIX.length));
    if (!e || !i || !t) return ct;
    const d = createDecipheriv(ALGO, key, Buffer.from(i, "base64"));
    d.setAuthTag(Buffer.from(t, "base64"));
    let dec = d.update(e, "base64", "utf8");
    dec += d.final("utf8");
    return dec;
  } catch (err) {
    console.warn(
      "[encryption] 解密失敗，金鑰不符或資料損毀:",
      (err as Error).message,
    );
    return ct;
  }
}

export function hasKey(): boolean {
  return getKey() !== null;
}

export function resetKey(): void {
  _key = null;
}
