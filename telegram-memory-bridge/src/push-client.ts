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
        console.log(`📤 推送 ${entries.length} 筆記憶...`);
        for (const e of entries) {
          const contentPath = resolve(opts.memoryPath, "entries", `${e.id}.md`);
          let content = e.summary;
          if (existsSync(contentPath)) {
            content = await readFile(contentPath, "utf-8");
          }
          try {
            const res = await fetch(`${peer}/api/push/memory`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: e.summary,
                category: e.category,
                importance: e.importance,
                tags: e.tags,
                content,
                _peer: device,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
              result.memory++;
              log.ok(`${e.summary.slice(0, 40)}`);
            } else {
              result.errors++;
              log.warn(`${e.summary.slice(0, 40)} → ${res.status}`);
            }
          } catch (err) {
            result.errors++;
            log.fail(`${e.summary.slice(0, 40)} → ${(err as Error).message}`);
          }
        }
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
      console.log(`📤 推送 ${files.length} 筆知識庫...`);
      for (const rel of files) {
        const full = resolve(opts.knowledgePath, rel);
        try {
          const content = await readFile(full, "utf-8");
          const title = rel.replace(/\.md$/, "").replace(/-/g, " ");
          const res = await fetch(`${peer}/api/push/knowledge`, {
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
            result.knowledge++;
            log.ok(`knowledge/${rel}`);
          } else {
            result.errors++;
            log.warn(`knowledge/${rel} → ${res.status}`);
          }
        } catch (err) {
          result.errors++;
          log.fail(`knowledge/${rel} → ${(err as Error).message}`);
        }
      }
    }
  }

  // ── 維基 ──
  if (existsSync(opts.wikiPath)) {
    const files = await walkDir(opts.wikiPath);
    if (files.length > 0) {
      console.log(`📤 推送 ${files.length} 筆維基...`);
      for (const rel of files) {
        const full = resolve(opts.wikiPath, rel);
        try {
          const content = await readFile(full, "utf-8");
          const id = rel.replace(/\.md$/, "");
          const category = dirname(rel);
          const cat = category === "." ? "general" : category;
          const res = await fetch(`${peer}/api/push/wiki`, {
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
            result.wiki++;
            log.ok(`wiki/${rel}`);
          } else {
            result.errors++;
            log.warn(`wiki/${rel} → ${res.status}`);
          }
        } catch (err) {
          result.errors++;
          log.fail(`wiki/${rel} → ${(err as Error).message}`);
        }
      }
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
