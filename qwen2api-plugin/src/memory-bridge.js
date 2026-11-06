/**
 * memory-bridge.js — 橋接 LanceDB 記憶庫至 Chat Proxy
 *
 * 直接讀取 memory-lancedb-pro 的 LanceDB 儲存，
 * 提供 BM25 關鍵字搜尋（無需嵌入 API），
 * 孤立異常自動降級，不影響 chat-proxy 正常運作。
 *
 * 載入注意：使用 createRequire 載入 @lancedb/lancedb，
 * 避免 Bun 全域快取導致 apache-arrow 解析失敗。
 * 這是記憶插件（memory-lancedb-pro）的標準做法。
 */

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { makeLogger } from "./color.js";
import { OPENCODE_DIR } from "./config/paths.js";

const _require = createRequire(import.meta.url);
const lancedb = _require("@lancedb/lancedb");

const log = makeLogger("memory-bridge", "muted");

// ═══ Fix 2026-07-09: 路徑修正 — 記憶已遷移至 projects/.opencode/memory/lancedb-pro ═══
// 原路徑 ~/.openclaw/memory/lancedb-pro 僅含空 __manifest（無 memories 表），
// 導致「記憶表不存在，跳過」、本地發現功能完全失效。
// 優先使用環境變數 MEMORY_DB_PATH，其次嘗試新舊兩個候選路徑，取第一個含表的。
const _candidates = [
  process.env.MEMORY_DB_PATH,
  path.join(OPENCODE_DIR, "memory", "lancedb-pro"),
  path.join(os.homedir(), ".openclaw", "memory", "lancedb-pro"),
].filter(Boolean);

const MEMORY_DB_PATH = (() => {
  for (const p of _candidates) {
    try {
      if (fs.existsSync(p) && fs.existsSync(path.join(p, "memories.lance"))) {
        return p;
      }
    } catch {}
  }
  return _candidates[_candidates.length - 1];
})();
const TABLE_NAME = "memories";

let _db = null;
let _table = null;
let _ready = false;
let _initAttempted = false;
let _count = 0;

/**
 * 初始化記憶橋接：連線 LanceDB、檢查表是否存在、統計筆數。
 * 非阻塞 — 失敗僅設 _ready=false，不拋出。
 */
async function init() {
  if (_initAttempted) return;
  _initAttempted = true;

  try {
    if (!fs.existsSync(MEMORY_DB_PATH)) {
      log.info("🧠 記憶庫不存在，跳過（記憶插件尚未寫入資料）");
      return;
    }

    _db = await lancedb.connect(MEMORY_DB_PATH);
    const names = await _db.tableNames();

    if (!names.includes(TABLE_NAME)) {
      log.info("🧠 記憶表不存在，跳過");
      return;
    }

    _table = await _db.openTable(TABLE_NAME);
    _count = await _table.countRows();

    if (_count === 0) {
      log.info("🧠 記憶庫為空，跳過");
      return;
    }

    _ready = true;
    log.info(`🧠 記憶橋接就緒: ${_count} 筆 (${MEMORY_DB_PATH})`);
  } catch (err) {
    log.warn(
      `🧠 記憶橋接初始化失敗（不影響 proxy）: ${(err.message || "").slice(0, 60)}`,
    );
    _ready = false;
  }
}

/**
 * 使用 BM25（FTS）搜尋相關記憶，回退至掃描式關鍵字比對。
 *
 * @param {string} query  — 查詢文字（通常為用戶最後一則訊息）
 * @param {number} limit  — 最多回傳筆數（預設 3）
 * @returns {Promise<string[]>} 記憶文字陣列
 */
async function recall(query, limit = 3) {
  if (!_ready || !_table) return [];

  try {
    const fetchLimit = Math.min(limit * 5, 30);
    let results;

    // 優先使用 FTS index（已在記憶插件初始化時建立）
    try {
      const q = _table.search(query, "fts").limit(fetchLimit);
      results = await q.toArray();
    } catch {
      // FTS index 不存在或查詢失敗 → 直接掃描
      results = [];
      try {
        const scan = await _table.query().limit(fetchLimit).toArray();
        results = scan;
      } catch {}
    }

    if (!results || results.length === 0) return [];

    // 依 BM25 score + 關鍵字命中 + importance 排序
    const normQ = query.toLowerCase().trim();
    const scored = [];

    for (const row of results) {
      const text = String(row.text || "");
      if (!text.trim()) continue;

      const rawScore = row._score != null ? Number(row._score) : 0;
      const importance = Number(row.importance || 0);

      // 若文字包含查詢詞，補償 BM25 可能偏低的 score
      const hasExact = normQ && text.toLowerCase().includes(normQ);
      const finalScore = hasExact ? Math.max(rawScore, 0.5) : rawScore;

      if (finalScore > 0 || hasExact) {
        scored.push({ text, score: finalScore, importance });
      }
    }

    // 排序：score DESC → importance DESC
    scored.sort((a, b) => {
      const d = b.score - a.score;
      return d !== 0 ? d : b.importance - a.importance;
    });

    return scored.slice(0, limit).map((r) => r.text);
  } catch (err) {
    log.warn(`🧠 記憶檢索失敗: ${(err.message || "").slice(0, 60)}`);
    return [];
  }
}

/** 橋接是否已就緒 */
function isReady() {
  return _ready;
}

export { init, recall, isReady };
