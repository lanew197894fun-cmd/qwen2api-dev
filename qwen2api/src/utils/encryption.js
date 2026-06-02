const crypto = require("crypto");

// ─── 常數 ───
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const PREFIX = "~ENC~";

// 快取 key 避免重複解析
let _key = null;
let _keyLoaded = false;

/**
 * 取得加密金鑰（HEX 編碼 64 字元 = 32 bytes，或 Base64 解碼後 32 bytes）
 * @returns {Buffer|null}
 */
function getKey() {
  if (_keyLoaded) return _key;

  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) {
    _key = null;
    _keyLoaded = true;
    return null;
  }

  // HEX: 64 字元 → 32 bytes
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    _key = Buffer.from(raw, "hex");
  } else {
    // Base64 → 解碼後必須為 32 bytes
    _key = Buffer.from(raw, "base64");
    if (_key.length !== KEY_LENGTH) {
      console.warn(
        `[ENCRYPTION] ENCRYPTION_KEY 解碼後長度為 ${_key.length}，預期 ${KEY_LENGTH} bytes，將回退為明文模式`,
      );
      _key = null;
    }
  }

  _keyLoaded = true;
  return _key;
}

/**
 * 重置 key 快取（用於熱更新配置）
 */
function resetKey() {
  _key = null;
  _keyLoaded = false;
}

/**
 * 加密字串
 * @param {string|null|undefined} plaintext
 * @returns {string} 加密後字串（含 ~ENC~ 前綴），無 key 時回傳原文
 */
function encrypt(plaintext) {
  const key = getKey();
  if (!key) return plaintext;
  if (plaintext == null) return plaintext;
  // 冪等性：已加密的資料不再重複加密
  if (String(plaintext).startsWith(PREFIX)) return plaintext;
  // 空字串不含機敏資料，跳過加密（AES-GCM 空輸入會產生無法解回空字串的密文）
  if (plaintext === "") return "";

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(String(plaintext), "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");

  return (
    PREFIX + JSON.stringify({ e: encrypted, i: iv.toString("base64"), t: tag })
  );
}

/**
 * 解密 ~ENC~ 前綴字串
 * @param {string|null|undefined} encryptedStr
 * @returns {string|null|undefined} 解密後原文，非加密格式時回傳原值
 */
function decrypt(encryptedStr) {
  const key = getKey();
  if (!key) return encryptedStr;
  if (!encryptedStr || typeof encryptedStr !== "string") return encryptedStr;

  // 無前綴 → 未加密（回溯相容）
  if (!encryptedStr.startsWith(PREFIX)) return encryptedStr;

  try {
    const payload = encryptedStr.slice(PREFIX.length);
    const { e, i, t } = JSON.parse(payload);
    if (!e || !i || !t) return encryptedStr;

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(i, "base64"),
    );
    decipher.setAuthTag(Buffer.from(t, "base64"));

    let decrypted = decipher.update(e, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.warn(
      "[ENCRYPTION] 解密失敗，可能金鑰不符或資料已損毀:",
      err.message,
    );
    return encryptedStr;
  }
}

/**
 * 是否有加密金鑰
 * @returns {boolean}
 */
function hasKey() {
  return getKey() !== null;
}

module.exports = { encrypt, decrypt, hasKey, resetKey };
