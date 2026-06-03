// Telegram Memory Bridge — push-client.ts
// 一次性推送：偵測到遠端 bridge 在線時，將本機資料推過去
// 推送完即結束，不佔背景資源

import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { hostname } from "os";

interface MemEntry {
  id: string;
  category: string;
  created: string;
  importance: number;
  tags: string[];
  summary: string;
}

interface PushOpts {
  peerUrl: string;
  memoryPath: string;
  knowledgePath: string;
  wikiPath: string;
}

interface PushResult {
  memory: number;
  knowledge: number;
  wiki: number;
  errors: number;
}

const log = {
  ok: (msg: string) => console.log(`  ✅ ${msg}`),
  warn: (msg: string) => console.log(`  ⚠️  ${msg}`),
  fail: (msg: string) => console.log(`  ❌ ${msg}`),
};

const BATCH_SIZE = 50;
const BASE_DELAY_MS = 1000;
const MAX_RETRIES = 5;

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
          `  ⏳ 429 Rate limited, backoff ${retryAfter}ms (attempt ${i + 1}/${MAX_RETRIES})`,
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
  console.log(`  📦 ${label}: ${items.length} 筆 → ${batches.length} 批次`);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`  🚀 批次 ${b + 1}/${batches.length} (${batch.length} 筆)`);
    for (const item of batch) {
      const r = await pushFn(item);
      if (r.ok) success++;
      else errors++;
    }
    if (b < batches.length - 1) {
      const delay = BASE_DELAY_MS * Math.pow(2, b);
      console.log(`  ⏱️ 批次間等待 ${delay}ms...`);
      await sleep(delay);
    }
  }
  return { success, errors };
}

export async function pushToPeer(opts: PushOpts): Promise<PushResult> {
  const peer = opts.peerUrl.replace(/\/+$/, "");
  const device = hostname();
  const result: PushResult = { memory: 0, knowledge: 0, wiki: 0, errors: 0 };

  console.log(`🌐 推送目標: ${peer}`);
  console.log(`📡 來源裝置: ${device}`);
  console.log("");

  // ── 記憶 ──
  const indexPath = resolve(opts.memoryPath, "memory-index.json");
  if (existsSync(indexPath)) {
    try {
      const raw = await readFile(indexPath, "utf-8");
      const entries = JSON.parse(raw) as MemEntry[];
      if (entries.length > 0) {
        const memItems = entries.map((e) => ({
          e,
          contentPath: resolve(opts.memoryPath, "entries", `${e.id}.md`),
        }));
        const r = await pushBatch(
          memItems,
          async ({ e, contentPath }) => {
            let content = e.summary;
            if (existsSync(contentPath)) {
              content = await readFile(contentPath, "utf-8");
            }
            return pushWithBackoff(
              `${peer}/api/push/memory`,
              {
                summary: e.summary,
                category: e.category,
                importance: e.importance,
                tags: e.tags,
                content,
                _peer: device,
              },
              10_000,
            );
          },
          "記憶",
        );
        result.memory = r.success;
        result.errors += r.errors;
      }
    } catch (err) {
      result.errors++;
      log.fail(`讀取記憶索引失敗: ${(err as Error).message}`);
    }
  }

  // ── 知識庫 ──
  if (existsSync(opts.knowledgePath)) {
    const files = await walkDir(opts.knowledgePath);
    if (files.length > 0) {
      const kItems = files.map((rel) => ({
        rel,
        full: resolve(opts.knowledgePath, rel),
      }));
      const r = await pushBatch(
        kItems,
        async ({ rel, full }) => {
          const content = await readFile(full, "utf-8");
          const title = rel.replace(/\.md$/, "").replace(/-/g, " ");
          return pushWithBackoff(
            `${peer}/api/push/knowledge`,
            {
              title,
              content,
              category: "peer-knowledge",
              tags: ["knowledge", "peer", device],
              _peer: device,
            },
            15_000,
          );
        },
        "知識庫",
      );
      result.knowledge = r.success;
      result.errors += r.errors;
    }
  }

  // ── 維基 ──
  if (existsSync(opts.wikiPath)) {
    const files = await walkDir(opts.wikiPath);
    if (files.length > 0) {
      const wItems = files.map((rel) => ({
        rel,
        full: resolve(opts.wikiPath, rel),
      }));
      const r = await pushBatch(
        wItems,
        async ({ rel, full }) => {
          const content = await readFile(full, "utf-8");
          const id = rel.replace(/\.md$/, "");
          const category = dirname(rel);
          const cat = category === "." ? "general" : category;
          return pushWithBackoff(
            `${peer}/api/push/wiki`,
            {
              id,
              content,
              category: cat,
              tags: ["wiki", "peer", device],
              _peer: device,
            },
            15_000,
          );
        },
        "維基",
      );
      result.wiki = r.success;
      result.errors += r.errors;
    }
  }

  return result;
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
