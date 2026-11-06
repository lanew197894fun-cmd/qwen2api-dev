// Telegram Memory Bridge — watcher.ts
// 監聽 wiki/ + knowledge/ 目錄異動，自動觸發索引更新
// 防抖 3s，避免批次寫入時重複執行

import { watch } from "fs";
import type { Indexer, IndexerPaths } from "./indexer.ts";

export class DirWatcher {
  private indexer: Indexer;
  private paths: IndexerPaths;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceMs = 3000;
  private onIndexed?: (r: {
    added: number;
    removed: number;
    updated: number;
    total: number;
  }) => void;

  constructor(
    indexer: Indexer,
    paths: IndexerPaths,
    onIndexed?: (r: {
      added: number;
      removed: number;
      updated: number;
      total: number;
    }) => void,
  ) {
    this.indexer = indexer;
    this.paths = paths;
    this.onIndexed = onIndexed;
  }

  start(): void {
    this.watchDir(this.paths.wikiDir, "wiki");
    this.watchDir(this.paths.knowledgeDir, "knowledge");
    console.log(
      `[watcher] 👀 監聽 ${this.paths.wikiDir} + ${this.paths.knowledgeDir}`,
    );
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    console.log("[watcher] ⏹ 已停止");
  }

  private watchDir(dir: string, label: string): void {
    try {
      const w = watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        // 只監聽 .md 檔案
        if (!name.endsWith(".md")) return;
        // 防抖
        const key = `${label}:${name}`;
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            this.indexer
              .scan()
              .then((r) => {
                // 有實際異動才通知 processor 起床工作
                if (this.onIndexed && (r.added > 0 || r.removed > 0))
                  this.onIndexed(r);
              })
              .catch((err) => {
                console.error(
                  `[watcher] ❌ 索引更新失敗:`,
                  (err as Error).message,
                );
              });
          }, this.debounceMs),
        );
      });
      this.watchers.push(w);
    } catch (err) {
      console.error(
        `[watcher] ⚠️ 無法監聽 ${label} (${dir}):`,
        (err as Error).message,
      );
    }
  }
}
