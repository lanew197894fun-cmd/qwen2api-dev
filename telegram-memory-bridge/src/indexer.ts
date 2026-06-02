// Telegram Memory Bridge — indexer.ts
// 自動掃描 wiki/ + knowledge/，同步更新 wiki-index.json
// 支援增量合併：保留手動設定的 tags/source，新增/移除對應條目

import { readdir, readFile, writeFile, stat, mkdir } from "fs/promises";
import { renameSync, existsSync } from "fs";
import { resolve, relative, dirname } from "path";

export interface IndexerPaths {
  wikiDir: string;
  wikiIndex: string;
  knowledgeDir: string;
}

interface WikiEntry {
  id?: string;
  title: string;
  category: string;
  tags?: string[];
  source?: string;
  wikiLinks?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface IndexData {
  entries: WikiEntry[];
  links: Record<string, string[]>;
}

const IGNORE_DIRS = new Set([".git", "node_modules", "__pycache__"]);

export class Indexer {
  private paths: IndexerPaths;
  private _running = false;

  constructor(paths: IndexerPaths) {
    this.paths = paths;
  }

  get running(): boolean {
    return this._running;
  }

  // ── 遞迴走訪目錄 ──

  private async walkDir(base: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (IGNORE_DIRS.has(e)) continue;
        const full = resolve(dir, e);
        try {
          const s = await stat(full);
          if (s.isDirectory()) await walk(full);
          else if (e.endsWith(".md")) files.push(full);
        } catch {
          /* skip unreadable */
        }
      }
    };
    await walk(base);
    return files;
  }

  // ── 標題萃取（第一個 # ）──

  private extractTitle(content: string): string | null {
    const m = content.match(/^#\s+(.+)/m);
    return m ? m[1].trim() : null;
  }

  // ── 分類 = 父目錄名 ──

  private extractCategory(relPath: string): string {
    const parts = relPath.replace(/\\/g, "/").split("/");
    return parts.length > 1 ? parts[0] : "未歸類";
  }

  // ── 萃取 wikiLinks：[[title]] + [text](path) ──

  private extractLinks(content: string): string[] {
    const links = new Set<string>();
    // [[title]] 跨條目關聯
    const wikiRefs = content.match(/\[\[([^\]]+)\]\]/g);
    if (wikiRefs)
      for (const ref of wikiRefs) links.add(ref.slice(2, -2).trim());
    // [text](path) 檔案參照（限含 / 或 .md）
    const mdLinks = content.match(/\[([^\]]*)\]\(([^)]+)\)/g);
    if (mdLinks)
      for (const link of mdLinks) {
        const m = link.match(/\[([^\]]*)\]\(([^)]+)\)/);
        if (m) {
          const p = m[2].trim();
          if (p.includes("/") || p.endsWith(".md")) links.add(p);
        }
      }
    return Array.from(links);
  }

  // ── ID = 路徑 slug ──

  private makeId(relPath: string): string {
    return relPath
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\/_-]/g, "-")
      .replace(/\/+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
  }

  // ── 掃描單一目錄 ──

  private async scanDir(
    base: string,
  ): Promise<{ entries: WikiEntry[]; links: Record<string, string[]> }> {
    const files = await this.walkDir(base);
    const entries: WikiEntry[] = [];
    const links: Record<string, string[]> = {};
    const now = new Date().toISOString();

    for (const fullPath of files) {
      const relPath = relative(base, fullPath).replace(/\\/g, "/");
      let content: string;
      try {
        content = await readFile(fullPath, "utf-8");
      } catch {
        continue;
      }
      const title = this.extractTitle(content) || relPath.replace(/\.md$/, "");
      const cat = this.extractCategory(relPath);
      const id = this.makeId(relPath);
      const rawLinks = this.extractLinks(content).filter(
        (l) => l !== title, // 避免自引用
      );
      // 驗證 wikiLinks：檔案參照需對應存在檔案，否則移除（孤立連結自動修復）
      const wikiLinks = rawLinks.filter((l) => {
        const isFileRef =
          l.includes(".") || l.includes("/") || l.includes("\\");
        if (!isFileRef) return true; // 純文字關聯保留
        const expected = resolve(base, l);
        const expectedMd = resolve(base, `${l}.md`);
        try {
          return existsSync(expected) || existsSync(expectedMd);
        } catch {
          return false;
        }
      });

      entries.push({
        id,
        title,
        category: cat,
        tags: [],
        source: "auto-indexer",
        wikiLinks,
        createdAt: now,
        updatedAt: now,
      });
      links[title] = [relPath];
    }

    return { entries, links };
  }

  // ── 讀取現有索引 ──

  private async readExisting(): Promise<IndexData | null> {
    try {
      const raw = await readFile(this.paths.wikiIndex, "utf-8");
      return JSON.parse(raw) as IndexData;
    } catch {
      return null;
    }
  }

  // ── 寫入（atomic rename）──

  private async writeIndex(data: IndexData): Promise<void> {
    await mkdir(dirname(this.paths.wikiIndex), { recursive: true });
    const tmp = this.paths.wikiIndex + ".tmp." + process.pid;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, this.paths.wikiIndex);
  }

  // ── 全量掃描 + 合併 ──

  async scan(): Promise<{
    added: number;
    removed: number;
    updated: number;
    total: number;
  }> {
    if (this._running) return { added: 0, removed: 0, updated: 0, total: 0 };
    this._running = true;
    const start = Date.now();

    try {
      const [wiki, knowledge] = await Promise.all([
        this.scanDir(this.paths.wikiDir),
        this.scanDir(this.paths.knowledgeDir),
      ]);

      const scanned = [...wiki.entries, ...knowledge.entries];
      const scannedLinks = { ...wiki.links, ...knowledge.links };

      const existing = await this.readExisting();
      if (!existing) {
        await this.writeIndex({ entries: scanned, links: scannedLinks });
        console.log(
          `[indexer] ✅ 新建索引: ${scanned.length} 條 (${Date.now() - start}ms)`,
        );
        return {
          added: scanned.length,
          removed: 0,
          updated: 0,
          total: scanned.length,
        };
      }

      // ── 合併邏輯 ──
      const oldMap = new Map(existing.entries.map((e) => [e.id, e]));
      const newEntries: WikiEntry[] = [];
      let added = 0,
        updated = 0;

      for (const entry of scanned) {
        const old = oldMap.get(entry.id);
        if (old) {
          newEntries.push({
            ...entry,
            tags: old.tags || entry.tags,
            source: old.source === "manual" ? "manual" : entry.source,
            createdAt: old.createdAt || entry.createdAt,
            wikiLinks: Array.from(
              new Set([...(old.wikiLinks || []), ...(entry.wikiLinks || [])]),
            ),
          });
          updated++;
          oldMap.delete(entry.id);
        } else {
          newEntries.push(entry);
          added++;
        }
      }

      // 殘留舊條目 = 已被刪除的檔案
      const removed = oldMap.size;

      // 合併 links
      const mergedLinks = { ...existing.links };
      for (const [title, paths] of Object.entries(scannedLinks)) {
        mergedLinks[title] = mergedLinks[title]
          ? [...new Set([...mergedLinks[title], ...paths])]
          : paths;
      }

      await this.writeIndex({ entries: newEntries, links: mergedLinks });
      console.log(
        `[indexer] ✅ 索引同步: +${added} / -${removed} / ~${updated} (共${newEntries.length}條, ${Date.now() - start}ms)`,
      );
      return { added, removed, updated, total: newEntries.length };
    } finally {
      this._running = false;
    }
  }
}
