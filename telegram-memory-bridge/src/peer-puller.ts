// Telegram Memory Bridge — peer-puller.ts
// 桌機 bridge 偵測到筆電上線時，自動拉取新記憶/知識/維基/教訓
// 🔒 安全：寫入後驗證內容 hash 一致，才對來源端發起 cleanup
// 🔄 穩定性：內建指數退避重試機制，應對網路波動

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import type { MemStore } from "./store.ts";
import type { MemEntry } from "./types.ts";

/** 指數退避重試 fetch（含 HTTP 5xx 重試） */
async function fetchWithRetry(
  url: string,
  opts: RequestInit & { signal?: AbortSignal },
  maxRetries = 3,
): Promise<Response> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts);
      // 重試伺服器錯誤（5xx）或特定客戶端錯誤（429 Too Many Requests）
      if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(
          `[pull]   🔄 HTTP ${res.status} 重試 ${url} (${attempt + 1}/${maxRetries})，${delay}ms 後重試...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(
          `[pull]   🔄 網路異常重試 ${url} (${attempt + 1}/${maxRetries})，${delay}ms 後重試...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw (
    lastErr || new Error(`Fetch failed after ${maxRetries} retries: ${url}`)
  );
}

interface PullResult {
  memory: number;
  knowledge: number;
  wiki: number;
  lesson: number;
  errors: number;
}

/** 已驗證的同步檔案（準備通知來源端 cleanup） */
interface SyncedFile {
  type: "knowledge" | "wiki" | "lesson";
  path: string;
}

export async function pullFromPeer(
  peerUrl: string,
  store: MemStore,
  knowledgePath: string,
  wikiPath: string,
  notify?: (summary: string) => void,
  peerName?: string,
  lessonPath?: string,
): Promise<void> {
  const base = peerUrl.replace(/\/+$/, "");
  const result: PullResult = {
    memory: 0,
    knowledge: 0,
    wiki: 0,
    lesson: 0,
    errors: 0,
  };
  const synced: SyncedFile[] = [];

  console.log(`[pull] 🔍 從 ${base} 拉取新資料...`);

  // ── 拉取記憶 ──
  try {
    const listRes = await fetchWithRetry(`${base}/api/list`, {
      signal: AbortSignal.timeout(8000),
    });
    if (listRes.ok) {
      const data = (await listRes.json()) as {
        entries: MemEntry[];
        device: string;
      };
      const local = await store.list();
      const localHashes = new Set(
        local.map((e) => {
          const hashInput = `${e.summary}|${e.category || ""}|${(e.tags || []).join(",")}`;
          return createHash("md5").update(hashInput).digest("hex");
        }),
      );

      const newEntries = data.entries.filter((e) => {
        const hashInput = `${e.summary}|${e.category || ""}|${(e.tags || []).join(",")}`;
        const hash = createHash("md5").update(hashInput).digest("hex");
        return !localHashes.has(hash);
      });

      if (newEntries.length > 0) {
        console.log(
          `[pull] 📤 拉取 ${newEntries.length} 筆新記憶（來自 ${data.device}）...`,
        );
        for (const e of newEntries) {
          try {
            const contentRes = await fetchWithRetry(
              `${base}/api/entry/${e.id}`,
              {
                signal: AbortSignal.timeout(5000),
              },
            );
            let content = e.summary;
            if (contentRes.ok) {
              const body = (await contentRes.json()) as { content: string };
              content = body.content;
            }
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

  // ── 拉取知識庫、維基、教訓（共用邏輯：寫入後驗證） ──
  for (const section of [
    {
      name: "知識庫",
      type: "knowledge" as const,
      remote: "knowledge",
      localDir: knowledgePath,
    },
    { name: "維基", type: "wiki" as const, remote: "wiki", localDir: wikiPath },
    {
      name: "教訓",
      type: "lesson" as const,
      remote: "lesson",
      localDir: lessonPath || "",
    },
  ]) {
    if (!section.localDir) continue;
    try {
      const listRes = await fetchWithRetry(`${base}/api/${section.remote}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!listRes.ok) continue;
      const data = (await listRes.json()) as {
        files: string[];
        device: string;
      };
      if (data.files.length === 0) continue;

      const localFiles = listLocalFiles(section.localDir);
      const newFiles = data.files.filter((f) => !localFiles.has(f));
      if (newFiles.length === 0) continue;

      console.log(
        `[pull] 📤 拉取 ${newFiles.length} 筆新${section.name}（來自 ${data.device}）...`,
      );
      for (const rel of newFiles) {
        try {
          const readRes = await fetchWithRetry(
            `${base}/api/read?type=${section.remote}&path=${encodeURIComponent(rel)}`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (!readRes.ok) {
            result.errors++;
            continue;
          }
          const body = (await readRes.json()) as { content: string };
          const content = body.content;

          // 寫入目的地（原子寫入）
          const dest = resolve(section.localDir, rel);
          await mkdir(resolve(dest, ".."), { recursive: true });
          const contentHash = createHash("md5").update(content).digest("hex");
          await atomicWriteFile(dest, content);

          // 🔒 驗證：讀回檔案比對 hash
          const written = await readFile(dest, "utf-8");
          const writtenHash = createHash("md5").update(written).digest("hex");
          if (writtenHash !== contentHash) {
            result.errors++;
            console.log(
              `[pull]   ❌ ${section.name}/${rel} 寫入驗證失敗（hash 不符），跳過 cleanup`,
            );
            continue;
          }

          // ✅ 寫入驗證通過，列入 cleanup 清單
          synced.push({ type: section.type, path: rel });
          result[section.type]++;
          console.log(`[pull]   ✅ ${section.name}/${rel} 寫入驗證通過`);
        } catch (err) {
          result.errors++;
          console.log(
            `[pull]   ⚠️ ${section.name}/${rel}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      result.errors++;
      console.log(
        `[pull]   ⚠️ 拉取${section.name}清單失敗: ${(err as Error).message}`,
      );
    }
  }

  // ── 通知來源端清理已驗證的檔案 ──
  if (synced.length > 0) {
    try {
      const cleanupRes = await fetchWithRetry(`${base}/api/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: synced }),
        signal: AbortSignal.timeout(15000),
      });
      if (cleanupRes.ok) {
        const r = (await cleanupRes.json()) as { deleted: number };
        console.log(`[pull] 🧹 來源端已清理 ${r.deleted} 個同步檔案`);
      } else {
        console.warn(`[pull] ⚠️ 來源端 cleanup 失敗 (${cleanupRes.status})`);
      }
    } catch (err) {
      console.warn(`[pull] ⚠️ 通知來源端清理失敗: ${(err as Error).message}`);
    }
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
  if (result.lesson > 0) parts.push(`教訓 ${result.lesson} 筆`);
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

// ── Atomic file write helper ──
async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        const { unlink } = await import("fs/promises");
        await unlink(tmpPath);
      }
    } catch {}
    throw err;
  }
}

function listLocalFiles(base: string): Set<string> {
  const set = new Set<string>();
  if (!base || !existsSync(base)) return set;
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
    /* */
  }
  return set;
}
