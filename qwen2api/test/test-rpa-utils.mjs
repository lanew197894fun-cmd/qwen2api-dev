#!/usr/bin/env bun
/**
 * test-rpa-utils.mjs — RPA 工具函數單元測試
 *
 * 獨立測試 browser-rpa.mjs 的智慧分段邏輯與 timeout 公式。
 * 不需瀏覽器或網路連線，純邏輯驗證。
 *
 * 用法：
 *   bun test/test-rpa-utils.mjs
 */

import { smartChunkSplit } from "../src/browser-rpa.mjs";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

// ── smartChunkSplit 測試 ──────────────────────────────────────────

console.log("\n=== smartChunkSplit ===");

// 1. 短訊息不分段
{
  const text = "你好，這是一段短訊息。";
  const chunks = smartChunkSplit(text, 100000);
  assert(chunks.length === 1, "短訊息應不分段");
  assert(chunks[0] === text, "短訊息內容應完整");
}

// 2. 等於 chunkSize 邊界
{
  const text = "a".repeat(100);
  const chunks = smartChunkSplit(text, 100);
  assert(chunks.length === 1, "等於邊界應不分段 (100字)");
  assert(chunks[0].length === 100, "內容長度應為 100");
}

// 3. 略大於 chunkSize（無換行，強制切）
{
  const text = "a".repeat(150);
  const chunks = smartChunkSplit(text, 100);
  assert(chunks.length === 2, "150字應分 2 段 (強制切)");
  assert(chunks[0].length === 100, "第一段應 100 字");
  assert(chunks[1].length === 50, "第二段應 50 字");
}

// 4. 有換行的智慧切分
{
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`line_${i}: ` + "x".repeat(20));
  }
  const text = lines.join("\n");
  const chunks = smartChunkSplit(text, 200);
  assert(chunks.length > 1, "長文應分段");
  // 檢查分段都在換行符邊界
  for (const chunk of chunks) {
    if (chunk !== chunks[chunks.length - 1]) {
      assert(
        chunk.endsWith("\n"),
        `非最後段應以換行結尾: "${chunk.slice(-20)}"`,
      );
    }
  }
}

// 5. 最後段不追加換行
{
  const text = "hello\nworld\nfoo\nbar\nbaz\nqux";
  const chunks = smartChunkSplit(text, 10);
  const last = chunks[chunks.length - 1];
  assert(!last.endsWith("\n"), `最後段不應以換行結尾: "${last}"`);
}

// 6. 避免短碎片（強制切換行<=10%時捨棄換行邊界）
{
  const text = "x".repeat(95) + "\n" + "y".repeat(95);
  const chunks = smartChunkSplit(text, 100);
  // 95字+換行+95字 = 191字, 應分2段
  assert(chunks.length === 2, "191 字應分 2 段");
  // 第一段可能不含換行（換行位置 > 100-30=70, 但 95-0=95 < 100*0.1=10 嗎？不對）
  // 檢查：回找 searchStart = max(1, 100-30) = 70, lastNewline in text at 95
  // lastNewline=95 > searchStart=70, 所以 end=96. 但 end-start=96-0=96 >= 10 ✓
  assert(
    chunks[0].length === 96,
    `第一段應 96 字 (含換行), 實際 ${chunks[0].length}`,
  );
}

// 7. 極短碎片保護（< 10% chunkSize 時不使用換行邊界）
{
  // 換行在第 98 字，searchStart=70, lastNewline=98 > 70
  // end=99, 99-0=99 >= 10 ✓ 保留換行邊界
  // 首段 = text.slice(0, 99) = 99 字（含換行）
  const text = "x".repeat(98) + "\n" + "y".repeat(200);
  const chunks = smartChunkSplit(text, 100);
  assert(
    chunks[0].length === 99,
    `換行邊界首段應 99 字, 實際 ${chunks[0].length}`,
  );
  assert(chunks[0].endsWith("\n"), "首段應以換行結尾");
}

// 8. 極短碎片保護 — 換行太靠近起點
{
  // chunkSize=500, text 在第 10 字有換行
  // searchStart = max(1, 500-150) = 350
  // lastNewline = 10 < searchStart, 所以不採用換行邊界
  const text = "a".repeat(10) + "\n" + "b".repeat(600);
  const chunks = smartChunkSplit(text, 500);
  // 因為換行回找限 searchStart=350, lastNewline=10 < 350, 所以用強制切
  assert(
    chunks[0].length === 500,
    `強制切首段 500 字, 實際 ${chunks[0].length}`,
  );
  assert(chunks[0].includes("\n"), "首段包含換行符");
}

// 9. 純換行內容
{
  const text = "\n\n\n\n\n";
  const chunks = smartChunkSplit(text, 2);
  assert(chunks.length > 0, "純換行應不分段錯誤");
  assert(chunks.join("") === text, "分段後內容不變");
}

// 10. 空字串
{
  const chunks = smartChunkSplit("", 100);
  assert(chunks.length === 1, "空字串應回傳 1 段");
  assert(chunks[0] === "", "空字串內容為空");
}

// 11. 超大 chunkSize（不分段）
{
  const text = "x".repeat(50000) + "\n" + "y".repeat(50000);
  const chunks = smartChunkSplit(text, 200000);
  assert(chunks.length === 1, "chunkSize > text 長度時不分段");
  assert(
    chunks[0].length === 100001,
    `內容長度應為 100001 (含換行), 實際 ${chunks[0].length}`,
  );
}

// 12. 多段落換行邊界
{
  const paragraphs = [];
  for (let i = 0; i < 8; i++) {
    paragraphs.push("p" + i + "_" + "x".repeat(60));
  }
  const text = paragraphs.join("\n");
  const chunks = smartChunkSplit(text, 200);
  assert(chunks.length >= 2, "8段60字文字+換行應分 >=2 段");
  for (const chunk of chunks) {
    if (chunk !== chunks[chunks.length - 1]) {
      assert(chunk.endsWith("\n"), "非最後段應在換行邊界");
    }
  }
}

// ── RPA_TIMEOUT 公式測試 ──────────────────────────────────────────

console.log("\n=== RPA_TIMEOUT 公式（request.js 公式）===");

function calcBpTimeout(len) {
  return Math.min(
    Math.max(60000, Math.ceil(len / 1000) * 5000 + 30000),
    300000,
  );
}

// 短訊息
{
  const t = calcBpTimeout(50);
  assert(t === 60000, `短訊息 timeout 應為 60s, 實際 ${t / 1000}s`);
}

// 10K 訊息
{
  const t = calcBpTimeout(10000);
  const expected = Math.min(Math.max(60000, 10 * 5000 + 30000), 300000);
  assert(
    t === 80000,
    `10K timeout 應為 80s, 實際 ${t / 1000}s (expected ${expected / 1000}s)`,
  );
}

// 50K 訊息
{
  const t = calcBpTimeout(50000);
  const expected = Math.min(Math.max(60000, 50 * 5000 + 30000), 300000);
  assert(t === 280000, `50K timeout 應為 280s, 實際 ${t / 1000}s`); // 50*5+30=280
}

// 95K 訊息（AI 最長思考時間）
{
  const t = calcBpTimeout(95000);
  assert(t === 300000, `95K timeout 應 cap 在 300s, 實際 ${t / 1000}s`);
}

// 103K 超長
{
  const t = calcBpTimeout(103000);
  assert(t === 300000, `103K timeout 應 cap 在 300s, 實際 ${t / 1000}s`);
}

// ── sendAndMonitor 雙重監控修復路徑測試 ──────────────────────────

console.log("\n=== sendAndMonitor 回傳型別 ===");

// 模擬 sendMessageChunked 回傳 {text, done}
// browser-proxy.js line 1222-1226 的 `typeof sent === "object" && sent.done` 檢查
{
  const mockChunkedResult = { text: "hello", done: true };
  const shouldSkipMonitor = !!(
    typeof mockChunkedResult === "object" &&
    mockChunkedResult !== null &&
    mockChunkedResult.done
  );
  assert(
    shouldSkipMonitor === true,
    "chunked 回傳 {text,done} 應跳過第二輪監控",
  );
}

{
  const mockBoolResult = true;
  const shouldSkipMonitor = !!(
    typeof mockBoolResult === "object" &&
    mockBoolResult !== null &&
    mockBoolResult.done
  );
  assert(shouldSkipMonitor === false, "布林 true 不應跳過監控");
}

{
  const mockBoolFalse = false;
  const shouldSkipMonitor = !!(
    typeof mockBoolFalse === "object" &&
    mockBoolFalse !== null &&
    mockBoolFalse.done
  );
  assert(shouldSkipMonitor === false, "布林 false 不應跳過監控");
}

{
  const mockObjNoDone = { text: "hello" };
  const shouldSkipMonitor = !!(
    typeof mockObjNoDone === "object" &&
    mockObjNoDone !== null &&
    mockObjNoDone.done
  );
  assert(shouldSkipMonitor === false, "物件無 done 不應跳過監控");
}

// ── 結果 ──
const total = passed + failed;
console.log(
  `\n=== 結果: ${passed}/${total} 通過${failed > 0 ? `, ${failed} 失敗` : ""} ===`,
);
process.exit(failed > 0 ? 1 : 0);
