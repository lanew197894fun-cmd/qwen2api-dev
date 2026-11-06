// Telegram Memory Bridge — processor.ts
// 待命背景處理：記憶驗證、知識庫掃描、維基索引檢查
// 全自動，無訊息時觸發

import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { suggest as govSuggest } from "./governor.ts";

export interface ProcessorPaths {
  memoryIndex: string; // memory-index.json
  memoryEntries: string; // entries/ dir
  knowledge: string; // knowledge/ dir
  wikiIndex: string; // wiki-index.json
  wiki: string; // wiki/ dir
}

export interface ProcReport {
  ok: boolean;
  summary: string;
  detail: string[];
}

// ── 記憶處理 ──
// 驗證索引 vs 實際檔案是否一致

async function processMemory(paths: ProcessorPaths): Promise<ProcReport> {
  const detail: string[] = [];

  // 讀索引
  let idx: { id: string; summary: string; category: string }[] = [];
  try {
    const raw = await readFile(paths.memoryIndex, "utf-8");
    idx = JSON.parse(raw) as any[];
    detail.push(`📋 記憶索引 ${idx.length} 筆`);
  } catch {
    detail.push("⚠️  記憶索引不存在或無法讀取");
    return { ok: false, summary: "記憶處理失敗（無索引）", detail };
  }

  // 檢查 entry 檔案
  let entryFiles: string[] = [];
  try {
    const files = await readdir(paths.memoryEntries);
    entryFiles = files.filter((f) => f.endsWith(".md"));
  } catch {
    detail.push("⚠️  entries 目錄不可讀");
  }

  // 比對：索引有但檔案不存在
  const missingFiles = idx.filter((e) => !entryFiles.includes(`${e.id}.md`));
  if (missingFiles.length > 0) {
    detail.push(`⚠️  索引 ${missingFiles.length} 筆無對應檔案`);
    for (const m of missingFiles.slice(0, 5))
      detail.push(`  · ${m.id} — ${m.summary.slice(0, 40)}`);
    if (missingFiles.length > 5)
      detail.push(`  · ... 還有 ${missingFiles.length - 5} 筆`);
  }

  // 比對：檔案存在但索引沒有
  const idxIds = new Set(idx.map((e) => e.id));
  const orphaned = entryFiles
    .map((f) => f.replace(/\.md$/, ""))
    .filter((id) => !idxIds.has(id));
  if (orphaned.length > 0) {
    detail.push(`⚠️  目錄 ${orphaned.length} 個檔案無索引記錄`);
    for (const o of orphaned.slice(0, 3)) detail.push(`  · ${o}`);
  }

  if (missingFiles.length === 0 && orphaned.length === 0)
    detail.push("✅ 索引與檔案一致");

  return { ok: true, summary: `記憶 ${idx.length} 筆`, detail };
}

// ── 知識庫掃描 ──

async function processKnowledge(paths: ProcessorPaths): Promise<ProcReport> {
  const detail: string[] = [];

  try {
    const cats = await readdir(paths.knowledge);
    let total = 0;
    for (const cat of cats) {
      const full = resolve(paths.knowledge, cat);
      try {
        const s = await stat(full);
        if (!s.isDirectory()) continue;
        const files = await readdir(full);
        const md = files.filter((f) => f.endsWith(".md"));
        if (md.length > 0) {
          detail.push(`📂 ${cat}: ${md.length} 篇`);
          total += md.length;
        }
      } catch {
        // skip unreadable
      }
    }
    if (total === 0) detail.push("📭 知識庫無內容");
    return { ok: true, summary: `知識庫 ${total} 篇`, detail };
  } catch {
    detail.push("⚠️  知識庫目錄不可讀");
    return { ok: false, summary: "知識庫處理失敗", detail };
  }
}

// ── 維基索引檢查 ──

async function processWiki(paths: ProcessorPaths): Promise<ProcReport> {
  const detail: string[] = [];

  // 讀 wiki-index.json
  let idx: { title: string; category?: string; wikiLinks?: string[] }[] = [];
  try {
    const raw = await readFile(paths.wikiIndex, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: any[] };
    idx = (parsed.entries ?? (parsed as any)) as any[];
    // handle both {entries: [...]} and direct array
    if (Array.isArray(parsed)) idx = parsed;
    else if (parsed.entries) idx = parsed.entries;
    detail.push(`📋 維基索引 ${idx.length} 筆`);
  } catch {
    detail.push("⚠️  維基索引不存在或無法讀取");
    return { ok: false, summary: "維基處理失敗（無索引）", detail };
  }

  // wikiLinks 分兩類：
  //   ① 檔案參照（有 .ext 或路徑符號）→ 檢查檔案是否存在
  //   ② 純文字關聯（概念性，如「知識庫」）→ 永遠不警告，這是跨條目標題關聯
  let missingFileLinks = 0;
  let softLinkCount = 0;
  for (const entry of idx) {
    if (!entry.wikiLinks?.length) continue;
    for (const link of entry.wikiLinks) {
      const isFileRef =
        link.includes(".") || link.includes("/") || link.includes("\\");
      if (isFileRef) {
        const expected = resolve(paths.wiki, link);
        const expectedMd = resolve(paths.wiki, `${link}.md`);
        if (!existsSync(expected) && !existsSync(expectedMd))
          missingFileLinks++;
      } else {
        softLinkCount++;
      }
    }
  }
  if (missingFileLinks > 0)
    detail.push(`⚠️  索引 ${missingFileLinks} 個 wikiLinks 無對應檔案`);
  else if (softLinkCount > 0)
    detail.push(`✅ 維基鏈結一致 (${softLinkCount} 個為跨條目關聯)`);
  else detail.push("✅ 維基鏈結一致");

  return { ok: true, summary: `維基 ${idx.length} 條`, detail };
}

// ── 演化報告（記憶成長追蹤）──

/** 記錄各輪的數據快照，用於計算成長 */
interface ProcSnapshot {
  cycle: number;
  at: number;
  memCount: number;
  knwCount: number;
  wikiCount: number;
}

const snapshots: ProcSnapshot[] = [];

function extractCount(summary: string): number {
  const m = summary.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function generateEvolutionReport(
  mem: ProcReport,
  knw: ProcReport,
  wik: ProcReport,
  cycle: number,
): string | null {
  const cur: ProcSnapshot = {
    cycle,
    at: Date.now(),
    memCount: extractCount(mem.summary),
    knwCount: extractCount(knw.summary),
    wikiCount: extractCount(wik.summary),
  };
  snapshots.push(cur);
  // 保留最近 20 筆
  if (snapshots.length > 20) snapshots.shift();

  // 至少需要 2 筆才能計算變化
  if (snapshots.length < 2) return null;

  const prev = snapshots[snapshots.length - 2];
  const memDelta = cur.memCount - prev.memCount;
  const knwDelta = cur.knwCount - prev.knwCount;
  const wikiDelta = cur.wikiCount - prev.wikiCount;
  const elapsed = ((cur.at - prev.at) / 1000 / 60).toFixed(1);

  // 無變化時跳過（避免刷頻）
  if (memDelta === 0 && knwDelta === 0 && wikiDelta === 0) return null;

  const report: string[] = [];
  report.push(`📊 *演化報告* (最近 ${elapsed} 分鐘)`);
  if (memDelta !== 0)
    report.push(
      `🧠 記憶: ${prev.memCount} → ${cur.memCount} (${memDelta > 0 ? "+" : ""}${memDelta})`,
    );
  if (knwDelta !== 0)
    report.push(
      `📚 知識庫: ${prev.knwCount} → ${cur.knwCount} (${knwDelta > 0 ? "+" : ""}${knwDelta})`,
    );
  if (wikiDelta !== 0)
    report.push(
      `📖 維基: ${prev.wikiCount} → ${cur.wikiCount} (${wikiDelta > 0 ? "+" : ""}${wikiDelta})`,
    );

  // 總成長
  const first = snapshots[0];
  if (first && first !== cur) {
    const totalMem = cur.memCount - first.memCount;
    const totalKnw = cur.knwCount - first.knwCount;
    const totalWiki = cur.wikiCount - first.wikiCount;
    report.push(
      `📈 總成長: +${totalMem} 記憶 / +${totalKnw} 知識 / +${totalWiki} 維基`,
    );
  }

  return report.join("\n");
}

// ── 主處理器 ──

export class IdleProcessor {
  private paths: ProcessorPaths;
  cycle = 0;
  private log: string[] = [];
  private running = false;

  constructor(paths: ProcessorPaths) {
    this.paths = paths;
  }

  // 執行一輪背景處理（被 bot idle 觸發）
  async runOnce(): Promise<string> {
    if (this.running) return "⏳ 前一轮處理未完成，跳過";

    // Governor 調度：系統忙碌時跳過背景處理
    const gov = govSuggest();
    if (gov.skipBg) return `⏭️ 背景跳過 (${gov.info})`;

    this.running = true;
    this.cycle++;
    const start = Date.now();

    try {
      const mem = await processMemory(this.paths);
      const knw = await processKnowledge(this.paths);
      const wik = await processWiki(this.paths);

      const lines: string[] = [];
      lines.push(`🔄 背景處理 #${this.cycle}`);
      lines.push(`📝 ${mem.summary}`);
      lines.push(`📚 ${knw.summary}`);
      lines.push(`📖 ${wik.summary}`);

      // 每 5 輪輸出一次詳細（避免刷屏）
      if (this.cycle % 5 === 1) {
        for (const d of [...mem.detail, ...knw.detail, ...wik.detail])
          lines.push(`  ${d}`);
      }

      // 每 3 輪產生演化報告
      if (this.cycle % 3 === 0) {
        const evo = generateEvolutionReport(mem, knw, wik, this.cycle);
        if (evo) {
          lines.push("");
          lines.push(evo);
        }
      }

      const elapsed = Date.now() - start;
      lines.push(`⚡ ${elapsed}ms`);
      return lines.join("\n");
    } finally {
      this.running = false;
    }
  }

  // 最近一輪摘要（給 console 用）
  lastLog(): string[] {
    return this.log.slice(-3);
  }
}
