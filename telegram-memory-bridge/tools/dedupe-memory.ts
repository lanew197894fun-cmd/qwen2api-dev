// 記憶重複資料清理 — 預設 dry-run，加 --apply 才實際刪除
// 背景：3670 筆記憶僅 60 筆不重複（2026-10-21 發現，store() 無冪等性）
import { MemStore } from "../src/store";
import { MEMORY_DIR } from "../../config/paths.js";
import { rm, readFile, writeFile } from "fs/promises";
import { resolve } from "path";

const apply = process.argv.includes("--apply");
const store = new MemStore(MEMORY_DIR);
const entries = await store.list();

// 依「摘要|分類|標籤」分組，保留第一筆（最早 created）
const groups = new Map<string, typeof entries>();
for (const e of entries) {
  const k = `${e.summary.trim()}|${e.category}|${[...e.tags].sort().join(",")}`;
  const g = groups.get(k);
  if (g) g.push(e);
  else groups.set(k, [e]);
}

const dupes = [...groups.values()].filter((g) => g.length > 1);
const removals = dupes.flatMap((g) =>
  g.slice(1).sort((a, b) => a.created.localeCompare(b.created)),
);
console.log(`總數 ${entries.length} → 不重複 ${groups.size}（將移除 ${removals.length} 筆重複）`);

if (!apply) {
  console.log("（dry-run：加 --apply 實際執行）");
  process.exit(0);
}

const keepIds = new Set(entries.filter((e) => !removals.includes(e)).map((e) => e.id));
for (const e of removals) {
  await rm(resolve(MEMORY_DIR, "entries", `${e.id}.md`), { force: true });
}
const idxPath = resolve(MEMORY_DIR, "memory-index.json");
await writeFile(idxPath, JSON.stringify(entries.filter((e) => keepIds.has(e.id)), null, 2), "utf-8");
console.log(`✅ 已清理，索引剩 ${keepIds.size} 筆`);
