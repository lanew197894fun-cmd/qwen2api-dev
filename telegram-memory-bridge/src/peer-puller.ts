// Telegram Memory Bridge — peer-puller.ts
// 桌機 bridge 偵測到筆電上線時，自動拉取新記憶/知識/維基
// 一次性拉取，零背景資源

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import type { MemStore } from "./store";
import type { MemEntry } from "./types";

interface PullResult {
  memory: number;
  knowledge: number;
  wiki: number;
  errors: number;
}

export async function pullFromPeer(
  peerUrl: string,
  store: MemStore,
  knowledgePath: string,
  wikiPath: string,
  notify?: (summary: string) => void,
  peerName?: string,
): Promise<void> {
  const base = peerUrl.replace(/\/+$/, "");
  const result: PullResult = { memory: 0, knowledge: 0, wiki: 0, errors: 0 };

  console.log(`[pull] 🔍 從 ${base} 拉取新資料...`);

  // ── 拉取記憶 ──
  try {
    const listRes = await fetch(`${base}/api/list`, {
      signal: AbortSignal.timeout(8000),
    });
    if (listRes.ok) {
      const data = (await listRes.json()) as {
        entries: MemEntry[];
        device: string;
      };
      const local = await store.list();
      // 用 summary 內容判重（而非 peer 原始 ID）
      // push 會在 Windows 端產生不同 ID，ID 比對會漏掉已推送的資料
      const localSummaries = new Set(local.map((e) => e.summary));
      const newEntries = data.entries.filter(
        (e) => !localSummaries.has(e.summary),
      );

      if (newEntries.length > 0) {
        console.log(
          `[pull] 📤 拉取 ${newEntries.length} 筆新記憶（來自 ${data.device}）...`,
        );
        for (const e of newEntries) {
          try {
            // 拉取詳細內容
            const contentRes = await fetch(`${base}/api/entry/${e.id}`, {
              signal: AbortSignal.timeout(5000),
            });
            let content = e.summary;
            if (contentRes.ok) {
              const body = (await contentRes.json()) as { content: string };
              content = body.content;
            }
            // 存入本地
            await store.store(e.summary, {
              category: e.category,
              importance: e.importance,
              tags: e.tags,
              content,
            });
            result.memory++;
          } catch (err) {
            result.errors++;
            console.log(`[pull]   ⚠️ ${e.id}: ${(err as Error).message}`);
          }
        }
      }
    }
  } catch (err) {
    result.errors++;
    console.log(`[pull]   ⚠️ 拉取記憶清單失敗: ${(err as Error).message}`);
  }

  // ── 拉取知識庫 ──
  try {
    const knowRes = await fetch(`${base}/api/knowledge`, {
      signal: AbortSignal.timeout(8000),
    });
    if (knowRes.ok) {
      const data = (await knowRes.json()) as {
        files: string[];
        device: string;
      };
      if (data.files.length > 0) {
        // 比對本地已有檔案
        const localFiles = listLocalFiles(knowledgePath);
        const newFiles = data.files.filter((f) => !localFiles.has(f));
        if (newFiles.length > 0) {
          console.log(
            `[pull] 📤 拉取 ${newFiles.length} 筆新知識庫（來自 ${data.device}）...`,
          );
          for (const rel of newFiles) {
            try {
              const readRes = await fetch(
                `${base}/api/read?type=knowledge&path=${encodeURIComponent(rel)}`,
                { signal: AbortSignal.timeout(10000) },
              );
              if (readRes.ok) {
                const body = (await readRes.json()) as { content: string };
                const dest = resolve(knowledgePath, rel);
                await mkdir(resolve(dest, ".."), { recursive: true });
                await writeFile(dest, body.content, "utf-8");
                result.knowledge++;
              }
            } catch (err) {
              result.errors++;
              console.log(
                `[pull]   ⚠️ knowledge/${rel}: ${(err as Error).message}`,
              );
            }
          }
        }
      }
    }
  } catch (err) {
    result.errors++;
    console.log(`[pull]   ⚠️ 拉取知識庫清單失敗: ${(err as Error).message}`);
  }

  // ── 拉取維基 ──
  try {
    const wikiRes = await fetch(`${base}/api/wiki`, {
      signal: AbortSignal.timeout(8000),
    });
    if (wikiRes.ok) {
      const data = (await wikiRes.json()) as {
        files: string[];
        device: string;
      };
      if (data.files.length > 0) {
        const localFiles = listLocalFiles(wikiPath);
        const newFiles = data.files.filter((f) => !localFiles.has(f));
        if (newFiles.length > 0) {
          console.log(
            `[pull] 📤 拉取 ${newFiles.length} 筆新維基（來自 ${data.device}）...`,
          );
          for (const rel of newFiles) {
            try {
              const readRes = await fetch(
                `${base}/api/read?type=wiki&path=${encodeURIComponent(rel)}`,
                { signal: AbortSignal.timeout(10000) },
              );
              if (readRes.ok) {
                const body = (await readRes.json()) as { content: string };
                const dest = resolve(wikiPath, rel);
                await mkdir(resolve(dest, ".."), { recursive: true });
                await writeFile(dest, body.content, "utf-8");
                result.wiki++;
              }
            } catch (err) {
              result.errors++;
              console.log(`[pull]   ⚠️ wiki/${rel}: ${(err as Error).message}`);
            }
          }
        }
      }
    }
  } catch (err) {
    result.errors++;
    console.log(`[pull]   ⚠️ 拉取維基清單失敗: ${(err as Error).message}`);
  }

  // ── 顯示結果 ──
  const now = new Date();
  const time = now.toLocaleTimeString("zh-TW", { hour12: false });
  const date = now.toLocaleDateString("zh-TW");
  const name =
    peerName || peerUrl.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  const parts: string[] = [];
  if (result.memory > 0) parts.push(`記憶 ${result.memory} 筆`);
  if (result.knowledge > 0) parts.push(`知識庫 ${result.knowledge} 筆`);
  if (result.wiki > 0) parts.push(`維基 ${result.wiki} 筆`);
  if (result.errors > 0) parts.push(`失敗 ${result.errors} 筆`);

  if (parts.length > 0) {
    const line = `同步完成: ${parts.join("、")}`;
    console.log(`[pull] ✅ ${line}`);
    notify?.(`📥 *${name}* ${line}\n⏱ ${date} ${time}`);
  } else {
    console.log(`[pull] ✅ 無新資料`);
    notify?.(`🔍 *${name}* 已檢查，無新資料\n⏱ ${date} ${time}`);
  }
}

function listLocalFiles(base: string): Set<string> {
  const set = new Set<string>();
  if (!existsSync(base)) return set;
  try {
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir)) {
        const full = resolve(dir, e);
        const s = statSync(full);
        if (s.isDirectory()) walk(full, prefix ? `${prefix}/${e}` : e);
        else if (e.endsWith(".md")) set.add(prefix ? `${prefix}/${e}` : e);
      }
    };
    walk(base, "");
  } catch {
    /* ignore */
  }
  return set;
}
