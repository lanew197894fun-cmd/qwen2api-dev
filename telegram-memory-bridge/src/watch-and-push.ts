/// <reference types="bun" />
// watch-and-push.ts — 輕量檔案監聽 + 主動推送代理
// 使用 polling 取代 recursive fs.watch，減少 Linux inotify 消耗
// 有事做工，無事待命中 — 僅砍掉「待命中」「調整」「跳過」三種重複噪音

import { watch } from "fs";
import { readFile, readdir, stat, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname, relative } from "path";
import { hostname } from "os";
import { suggest } from "./governor.ts";

// ── JS-length-aware truncation ──
// JS `.length` = UTF-16 code units. Emoji (Non-BMP) = 2 units, Python `len()` = 1.
// Ensures payloads pass API's `validStr` checks without HTTP 400.
function truncToJSLen(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  let n = 0;
  let out = "";
  for (const c of chars) {
    const add = c.length;
    if (n + add > max - 3) break;
    out += c;
    n += add;
  }
  return out + "...";
}

interface PushOpts {
  peerUrl: string;
  memoryRoot: string;
  knowledgeRoot: string;
  wikiRoot: string;
  lessonRoot: string;
}

interface FileMeta {
  path: string;
  mtime: number;
}

interface PushHistory {
  memory: string[];
  knowledge: FileMeta[];
  wiki: FileMeta[];
  lesson: FileMeta[];
}

let _peerUrl = "";
let _opts: PushOpts | null = null;
let _history: PushHistory = { memory: [], knowledge: [], wiki: [], lesson: [] };

function toMeta(p: string, m: number): FileMeta {
  return { path: p, mtime: m };
}

function hasMeta(arr: FileMeta[], p: string, m: number): boolean {
  const f = arr.find((x) => x.path === p);
  return !!f && f.mtime >= m;
}

function upsertMeta(arr: FileMeta[], p: string, m: number): void {
  const i = arr.findIndex((x) => x.path === p);
  if (i >= 0) arr[i] = toMeta(p, m);
  else arr.push(toMeta(p, m));
}
let _historyPath = "";
let _busy = false;
let _pollBusy = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _fsWatcher: ReturnType<typeof watch> | null = null;
const _debounceMs = 5000;
let _pollMs = 120_000;
let _pollCycle = 0;
const BATCH_SIZE = 50;
const BASE_DELAY_MS = 1000;
const MAX_RETRIES = 5;

function tag(): string {
  return `[push ${new Date().toLocaleTimeString()}]`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pushWithBackoff(
  url: string,
  body: any,
  timeout: number,
): Promise<{ ok: boolean; status: number }> {
  let delay = BASE_DELAY_MS;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429) {
        const retryAfter = parseInt(
          res.headers.get("Retry-After") || String(Math.min(delay * 2, 60_000)),
        );
        console.log(
          `${tag()} ⏳ 429 Rate limited, backoff ${retryAfter}ms (attempt ${i + 1}/${MAX_RETRIES})`,
        );
        await sleep(retryAfter);
        delay = Math.min(delay * 2, 60_000);
        continue;
      }
      return { ok: res.ok, status: res.status };
    } catch (err) {
      if (i < MAX_RETRIES - 1) {
        await sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }
  return { ok: false, status: 0 };
}

async function loadHistory(): Promise<void> {
  if (!_historyPath) return;
  try {
    if (existsSync(_historyPath)) {
      const loaded = JSON.parse(await readFile(_historyPath, "utf-8"));
      _history.memory = loaded.memory ?? [];
      _history.knowledge = loaded.knowledge ?? [];
      _history.wiki = loaded.wiki ?? [];
      _history.lesson = loaded.lesson ?? [];
    }
  } catch {}
}

async function saveHistory(): Promise<void> {
  if (!_historyPath) return;
  try {
    if (_history.memory.length > 5000)
      _history.memory = _history.memory.slice(-3000);
    if (_history.knowledge.length > 2000)
      _history.knowledge = _history.knowledge.slice(-1000);
    if (_history.wiki.length > 2000) _history.wiki = _history.wiki.slice(-1000);
    if (_history.lesson.length > 2000)
      _history.lesson = _history.lesson.slice(-1000);
    await writeFile(_historyPath, JSON.stringify(_history), "utf-8");
  } catch {}
}

async function pushBatch(
  items: any[],
  pushFn: (item: any) => Promise<{ ok: boolean; status: number }>,
  label: string,
): Promise<{ success: number; errors: number }> {
  let success = 0;
  let errors = 0;
  const batches: any[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  if (batches.length > 1)
    console.log(
      `${tag()} 📦 ${label}: ${items.length} 筆 → ${batches.length} 批次`,
    );
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batches.length > 1)
      console.log(
        `${tag()} 🚀 批次 ${b + 1}/${batches.length} (${batch.length} 筆)`,
      );
    for (const item of batch) {
      const r = await pushFn(item);
      if (r.ok) success++;
      else errors++;
      await sleep(50);
    }
    if (b < batches.length - 1) {
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, b), 30000);
      console.log(`${tag()} ⏱️ 批次間等待 ${delay}ms...`);
      await sleep(delay);
    }
  }
  return { success, errors };
}

const PUSH_TIMEOUT_MS = 60_000;

async function doPush(): Promise<void> {
  if (_busy) return;
  _busy = true;
  const device = hostname();
  let pushed = 0;

  const timeoutId = setTimeout(() => {
    if (_busy) {
      console.log(`${tag()} ⚠️ 推送超時 (${PUSH_TIMEOUT_MS}ms)，強制重置`);
      _busy = false;
    }
  }, PUSH_TIMEOUT_MS);

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
      const newEntries = entries.filter((e) => !known.has(e.id));
      if (newEntries.length > 0) {
        const memItems = newEntries.map((e) => ({
          e,
          contentPath: resolve(_opts!.memoryRoot, "entries", `${e.id}.md`),
        }));
        const r = await pushBatch(
          memItems,
          async ({ e, contentPath }) => {
            let content = e.summary;
            if (existsSync(contentPath))
              content = await readFile(contentPath, "utf-8");
            const result = await pushWithBackoff(
              `${_peerUrl}/api/push/memory`,
              {
                summary: truncToJSLen(e.summary, 1000),
                category: e.category || "general",
                importance: e.importance ?? 0.7,
                tags: e.tags || [],
                content,
                _peer: device,
              },
              10_000,
            );
            if (result.ok) _history.memory.push(e.id);
            return result;
          },
          "記憶",
        );
        pushed += r.success;
      }
    }
    await saveHistory();
    await sleep(50);

    // ── 知識庫 ──
    if (existsSync(_opts!.knowledgeRoot)) {
      const files = await walkDir(_opts!.knowledgeRoot);
      const newFiles: { rel: string; mtime: number }[] = [];
      for (const f of files) {
        try {
          const s = await stat(resolve(_opts!.knowledgeRoot, f));
          const mtime = s.mtimeMs;
          if (!hasMeta(_history.knowledge, f, mtime)) {
            newFiles.push({ rel: f, mtime });
          }
        } catch {}
      }

      if (newFiles.length > 0) {
        const r = await pushBatch(
          newFiles,
          async ({ rel, mtime }) => {
            const full = resolve(_opts!.knowledgeRoot, rel);
            const content = await readFile(full, "utf-8");
            const title = rel.replace(/\.md$/, "").replace(/[_-]/g, " ");
            const result = await pushWithBackoff(
              `${_peerUrl}/api/push/knowledge`,
              {
                title,
                content,
                category: "peer-knowledge",
                tags: ["knowledge", "peer", device],
                _peer: device,
              },
              15_000,
            );
            if (result.ok) upsertMeta(_history.knowledge, rel, mtime);
            return result;
          },
          "知識庫",
        );
        pushed += r.success;
      }
    }
    await saveHistory();
    await sleep(50);

    // ── 維基 ──
    if (existsSync(_opts!.wikiRoot)) {
      const files = await walkDir(_opts!.wikiRoot);
      const newFiles: { rel: string; mtime: number }[] = [];
      for (const f of files) {
        try {
          const s = await stat(resolve(_opts!.wikiRoot, f));
          const mtime = s.mtimeMs;
          if (!hasMeta(_history.wiki, f, mtime)) {
            newFiles.push({ rel: f, mtime });
          }
        } catch {}
      }

      if (newFiles.length > 0) {
        const r = await pushBatch(
          newFiles,
          async ({ rel, mtime }) => {
            const full = resolve(_opts!.wikiRoot, rel);
            const content = await readFile(full, "utf-8");
            const id = rel.replace(/\.md$/, "");
            const cat = dirname(rel) === "." ? "general" : dirname(rel);
            const result = await pushWithBackoff(
              `${_peerUrl}/api/push/wiki`,
              {
                id,
                content,
                category: cat,
                tags: ["wiki", "peer", device],
                _peer: device,
              },
              15_000,
            );
            if (result.ok) upsertMeta(_history.wiki, rel, mtime);
            return result;
          },
          "維基",
        );
        pushed += r.success;
      }
    }
    await saveHistory();
    await sleep(50);

    // ═══ Fix 2026-07-14: lesson 推送 — skill/lesson/ 目錄下的學習經驗 ═══
    if (_opts!.lessonRoot && existsSync(_opts!.lessonRoot)) {
      const files = await walkDir(_opts!.lessonRoot);
      const newFiles: { rel: string; mtime: number }[] = [];
      for (const f of files) {
        try {
          const s = await stat(resolve(_opts!.lessonRoot, f));
          const mtime = s.mtimeMs;
          if (!hasMeta(_history.lesson, f, mtime)) {
            newFiles.push({ rel: f, mtime });
          }
        } catch {}
      }

      if (newFiles.length > 0) {
        const r = await pushBatch(
          newFiles,
          async ({ rel, mtime }) => {
            const full = resolve(_opts!.lessonRoot, rel);
            const content = await readFile(full, "utf-8");
            const id = rel.replace(/\.md$/, "");
            const result = await pushWithBackoff(
              `${_peerUrl}/api/push/wiki`,
              {
                id: `lesson/${id}`,
                content,
                category: "lesson",
                tags: ["lesson", "peer", device],
                _peer: device,
              },
              15_000,
            );
            if (result.ok) upsertMeta(_history.lesson, rel, mtime);
            return result;
          },
          "學習經驗",
        );
        pushed += r.success;
      }
    }

    await saveHistory();
  } catch (err) {
    console.log(`${tag()} ❌ 推送異常: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeoutId);
    _busy = false;
  }
  if (pushed > 0) console.log(`${tag()} ✅ 推送 ${pushed} 筆完成`);
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
      } catch {}
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
    for (const f of files) {
      try {
        const s = await stat(resolve(_opts!.knowledgeRoot, f));
        if (!hasMeta(_history.knowledge, f, s.mtimeMs)) count++;
      } catch {}
    }
  }
  if (existsSync(_opts!.wikiRoot)) {
    const files = await walkDir(_opts!.wikiRoot);
    for (const f of files) {
      try {
        const s = await stat(resolve(_opts!.wikiRoot, f));
        if (!hasMeta(_history.wiki, f, s.mtimeMs)) count++;
      } catch {}
    }
  }
  // ═══ lesson dryRun ═══
  if (_opts!.lessonRoot && existsSync(_opts!.lessonRoot)) {
    const files = await walkDir(_opts!.lessonRoot);
    for (const f of files) {
      try {
        const s = await stat(resolve(_opts!.lessonRoot, f));
        if (!hasMeta(_history.lesson, f, s.mtimeMs)) count++;
      } catch {}
    }
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
    `[watch-push] 📋 歷史: ${_history.memory.length}M ${_history.knowledge.length}K ${_history.wiki.length}W ${_history.lesson.length}L`,
  );

  // 啟動後先檢查一次
  const n = await dryRun();
  if (n > 0) {
    console.log(`[watch-push] 🔍 ${n} 筆未推送`);
    await doPush();
  }

  // ── 記憶索引：單檔 fs.watch（低成本） ──
  const idxPath = resolve(opts.memoryRoot, "memory-index.json");
  if (existsSync(idxPath)) {
    try {
      _fsWatcher = watch(idxPath, (evt) => {
        if (evt === "change") trigger();
      });
    } catch (err) {
      console.log(`[watch-push] ⚠️ 無法監聽索引: ${(err as Error).message}`);
    }
  } else {
    console.log(`[watch-push] ℹ️ 索引尚未建立 (${idxPath})，polling 會接手`);
  }

  // ── 知識庫 + 維基：polling ──
  const runPoll = async () => {
    if (_pollBusy) {
      _pollTimer = setTimeout(runPoll, _pollMs) as unknown as ReturnType<
        typeof setInterval
      >;
      return;
    }
    _pollBusy = true;
    try {
      const gov = suggest();
      const suggestedPollMs = gov.pollMs * 10;
      if (suggestedPollMs !== _pollMs) {
        _pollMs = suggestedPollMs;
      }
      const pending = await dryRun();
      if (pending > 0) {
        console.log(`[watch-push] 🔍 polling 發現 ${pending} 筆新資料`);
        doPush().catch(() => {});
      }
    } finally {
      _pollBusy = false;
      _pollTimer = setTimeout(runPoll, _pollMs) as unknown as ReturnType<
        typeof setInterval
      >;
    }
  };
  _pollTimer = setTimeout(runPoll, _pollMs) as unknown as ReturnType<
    typeof setInterval
  >;

  console.log(
    `[watch-push] ✅ 就緒（fs.watch 索引 + polling ${_pollMs / 1000}s 知識/維基）`,
  );
}

export function stopWatchAndPush(): void {
  if (_timer) clearTimeout(_timer);
  if (_pollTimer) clearTimeout(_pollTimer);
  if (_fsWatcher) {
    _fsWatcher.close();
    _fsWatcher = null;
  }
  _timer = null;
  _pollTimer = null;
  _pollBusy = false;
  console.log(`[watch-push] ⏹ 已停止`);
}
