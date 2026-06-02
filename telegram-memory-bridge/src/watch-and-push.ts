/// <reference types="bun" />
// watch-and-push.ts — 輕量檔案監聽 + 主動推送代理
// 使用 polling 取代 recursive fs.watch，減少 Linux inotify 消耗
// 有事做工，無事待命中

import { watch } from "fs";
import { readFile, readdir, stat, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname, relative } from "path";
import { hostname } from "os";

interface PushOpts {
  peerUrl: string;
  memoryRoot: string;
  knowledgeRoot: string;
  wikiRoot: string;
}

interface PushHistory {
  memory: string[];
  knowledge: string[];
  wiki: string[];
}

let _peerUrl = "";
let _opts: PushOpts | null = null;
let _history: PushHistory = { memory: [], knowledge: [], wiki: [] };
let _historyPath = "";
let _busy = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const _debounceMs = 5000;
const _pollMs = 30_000; // polling 間隔（取代 recursive fs.watch）

function tag(): string {
  return `[push ${new Date().toLocaleTimeString()}]`;
}
function idle(): void {
  console.log(`${tag()} 待命中...`);
}

async function loadHistory(): Promise<void> {
  if (!_historyPath) return;
  try {
    if (existsSync(_historyPath))
      _history = JSON.parse(await readFile(_historyPath, "utf-8"));
  } catch {}
}

async function saveHistory(): Promise<void> {
  if (!_historyPath) return;
  try {
    // 歷史過長時修剪（防止無限膨脹）
    if (_history.memory.length > 5000)
      _history.memory = _history.memory.slice(-3000);
    if (_history.knowledge.length > 2000)
      _history.knowledge = _history.knowledge.slice(-1000);
    if (_history.wiki.length > 2000) _history.wiki = _history.wiki.slice(-1000);
    await writeFile(_historyPath, JSON.stringify(_history), "utf-8");
  } catch {}
}

async function doPush(): Promise<void> {
  if (_busy) return;
  _busy = true;
  const device = hostname();
  let pushed = 0;

  try {
    // ── 記憶 ──
    const indexPath = resolve(_opts!.memoryRoot, "memory-index.json");
    if (existsSync(indexPath)) {
      const raw = await readFile(indexPath, "utf-8");
      const entries = JSON.parse(raw) as {
        id: string;
        summary: string;
        category?: string;
        importance?: number;
        tags?: string[];
      }[];
      const known = new Set(_history.memory);
      for (const e of entries) {
        if (known.has(e.id)) continue;
        const cp = resolve(_opts!.memoryRoot, "entries", `${e.id}.md`);
        let content = e.summary;
        if (existsSync(cp)) content = await readFile(cp, "utf-8");
        try {
          const res = await fetch(`${_peerUrl}/api/push/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              summary: e.summary,
              category: e.category || "general",
              importance: e.importance ?? 0.7,
              tags: e.tags || [],
              content,
              _peer: device,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            _history.memory.push(e.id);
            pushed++;
          } else console.log(`${tag()} ⚠️ 記憶 ${e.id} → ${res.status}`);
        } catch (err) {
          console.log(`${tag()} ⚠️ 記憶 ${e.id} → ${(err as Error).message}`);
        }
      }
    }

    // ── 知識庫 ──
    if (existsSync(_opts!.knowledgeRoot)) {
      const files = await walkDir(_opts!.knowledgeRoot);
      const known = new Set(_history.knowledge);
      for (const rel of files) {
        if (known.has(rel)) continue;
        try {
          const full = resolve(_opts!.knowledgeRoot, rel);
          const content = await readFile(full, "utf-8");
          const title = rel.replace(/\.md$/, "").replace(/[_-]/g, " ");
          const res = await fetch(`${_peerUrl}/api/push/knowledge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              content,
              category: "peer-knowledge",
              tags: ["knowledge", "peer", device],
              _peer: device,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            _history.knowledge.push(rel);
            pushed++;
          } else console.log(`${tag()} ⚠️ 知識 ${rel} → ${res.status}`);
        } catch (err) {
          console.log(`${tag()} ⚠️ 知識 ${rel} → ${(err as Error).message}`);
        }
      }
    }

    // ── 維基 ──
    if (existsSync(_opts!.wikiRoot)) {
      const files = await walkDir(_opts!.wikiRoot);
      const known = new Set(_history.wiki);
      for (const rel of files) {
        if (known.has(rel)) continue;
        try {
          const full = resolve(_opts!.wikiRoot, rel);
          const content = await readFile(full, "utf-8");
          const id = rel.replace(/\.md$/, "");
          const cat = dirname(rel) === "." ? "general" : dirname(rel);
          const res = await fetch(`${_peerUrl}/api/push/wiki`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id,
              content,
              category: cat,
              tags: ["wiki", "peer", device],
              _peer: device,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            _history.wiki.push(rel);
            pushed++;
          } else console.log(`${tag()} ⚠️ 維基 ${rel} → ${res.status}`);
        } catch (err) {
          console.log(`${tag()} ⚠️ 維基 ${rel} → ${(err as Error).message}`);
        }
      }
    }

    await saveHistory();
  } catch (err) {
    console.log(`${tag()} ❌ 推送異常: ${(err as Error).message}`);
  }

  _busy = false;
  if (pushed === 0) idle();
  else console.log(`${tag()} ✅ 推送 ${pushed} 筆完成`);
}

function trigger(): void {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    doPush().catch(() => {});
  }, _debounceMs);
}

async function walkDir(base: string): Promise<string[]> {
  const IGNORE = new Set([".git", "node_modules", "__pycache__"]);
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e)) continue;
      const full = resolve(dir, e);
      try {
        const s = await stat(full);
        if (s.isDirectory()) await walk(full, prefix ? `${prefix}/${e}` : e);
        else if (e.endsWith(".md")) files.push(prefix ? `${prefix}/${e}` : e);
      } catch {
        /* skip */
      }
    }
  };
  await walk(base, "");
  return files;
}

async function dryRun(): Promise<number> {
  let count = 0;
  const indexPath = resolve(_opts!.memoryRoot, "memory-index.json");
  if (existsSync(indexPath)) {
    const raw = await readFile(indexPath, "utf-8");
    const entries = JSON.parse(raw) as { id: string }[];
    const known = new Set(_history.memory);
    count += entries.filter((e) => !known.has(e.id)).length;
  }
  if (existsSync(_opts!.knowledgeRoot)) {
    const files = await walkDir(_opts!.knowledgeRoot);
    count += files.filter((f) => !new Set(_history.knowledge).has(f)).length;
  }
  if (existsSync(_opts!.wikiRoot)) {
    const files = await walkDir(_opts!.wikiRoot);
    count += files.filter((f) => !new Set(_history.wiki).has(f)).length;
  }
  return count;
}

export async function startWatchAndPush(opts: PushOpts): Promise<void> {
  _opts = opts;
  _peerUrl = opts.peerUrl.replace(/\/+$/, "");
  _historyPath = resolve(opts.memoryRoot, "../watch-push-history.json");
  await loadHistory();

  console.log(`[watch-push] 🚀 啟動`);
  console.log(`[watch-push] 🎯 ${_peerUrl}`);
  console.log(
    `[watch-push] 📡 記憶=${opts.memoryRoot} 知識=${opts.knowledgeRoot} 維基=${opts.wikiRoot}`,
  );
  console.log(
    `[watch-push] 📋 歷史: ${_history.memory.length}M ${_history.knowledge.length}K ${_history.wiki.length}W`,
  );

  // 啟動後先檢查一次
  const n = await dryRun();
  if (n > 0) {
    console.log(`[watch-push] 🔍 ${n} 筆未推送`);
    await doPush();
  } else idle();

  // ── 記憶索引：單檔 fs.watch（低成本） ──
  const idxPath = resolve(opts.memoryRoot, "memory-index.json");
  try {
    const w = watch(idxPath, (evt) => {
      if (evt === "change") trigger();
    });
    // 不需要保存 watcher 到陣列，單檔無洩漏風險
    // 但需要留著以便關閉。用 stopWatchAndPush 處理
  } catch (err) {
    console.log(`[watch-push] ⚠️ 無法監聽索引: ${(err as Error).message}`);
  }

  // ── 知識庫 + 維基：polling 取代 recursive fs.watch（避免 inotify 爆炸） ──
  _pollTimer = setInterval(async () => {
    const n = await dryRun();
    if (n > 0) {
      console.log(`[watch-push] 🔍 polling 發現 ${n} 筆新資料`);
      doPush().catch(() => {});
    }
  }, _pollMs);

  console.log(
    `[watch-push] ✅ 就緒（fs.watch 索引 + polling ${_pollMs / 1000}s 知識/維基）`,
  );
}

export function stopWatchAndPush(): void {
  if (_timer) clearTimeout(_timer);
  if (_pollTimer) clearInterval(_pollTimer);
  _timer = null;
  _pollTimer = null;
  console.log(`[watch-push] ⏹ 已停止`);
}
