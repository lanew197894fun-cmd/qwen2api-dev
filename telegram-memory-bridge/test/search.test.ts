// 記憶檢索真實驗證 — 對 3670 筆實際記憶測試
import { test, expect } from "bun:test";
import { MemStore } from "../src/store";
import { MEMORY_DIR } from "../../config/paths.js";

const store = new MemStore(MEMORY_DIR);

test("P0: contextMemories 零模型成本且夠快（<200ms）", async () => {
  const t0 = performance.now();
  const txt = await store.contextMemories("qwen2api 記憶橋接架構設計", 3);
  const ms = Math.round(performance.now() - t0);
  console.log(`[測試] contextMemories ${ms}ms → ${txt ? txt.split("\n").length : 0} 筆背景`);
  expect(ms).toBeLessThan(200);
  expect(txt.length).toBeGreaterThan(0);
}, 30000);

test("P0: recall 純關鍵字檢索可用且快速", async () => {
  const t0 = performance.now();
  const res = await store.recall("telegram", 5);
  console.log(`[測試] recall ${Math.round(performance.now() - t0)}ms, ${res.entries.length} 筆`);
  expect(res.entries.length).toBeGreaterThan(0);
}, 30000);

test("P0: searchByModel 明確搜尋不回傳無關記憶", async () => {
  // 純亂碼（無任何中文 bigram / 英文單詞可命中）
  const res = await store.searchByModel("qqzzxy9876vwt", 3);
  console.log(`[測試] 無命中 → ${res.entries.length} 筆（應為 0）`);
  expect(res.entries.length).toBe(0);
}, 90000);

test("P0: searchByModel 命中時模型失敗仍降級回關鍵字結果", async () => {
  const res = await store.searchByModel("telegram 記憶橋接", 5);
  console.log(`[測試] 命中 → ${res.entries.length} 筆`);
  expect(res.entries.length).toBeGreaterThan(0);
}, 90000);

test("P0: 關鍵字分數為 0~1 絕對相關度", async () => {
  const res = await store.recall("telegram 記憶", 10);
  const scores = res.entries.map((e) => e.score);
  for (const s of scores) {
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  }
  console.log(`[測試] 分數: ${scores.map((s) => (s * 100).toFixed(0) + "%").join(", ")}`);
}, 30000);

test("P0: 檢索結果無重複內容（待資料清理後通過）", async () => {
  const res = await store.recall("telegram 記憶", 10);
  const uniq = new Set(res.entries.map((e) => e.summary.trim()));
  console.log(`[測試] ${res.entries.length} 筆中 ${uniq.size} 筆不重複`);
  expect(uniq.size).toBe(res.entries.length);
}, 30000);
