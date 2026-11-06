// File-based knowledge provider

import type {
  IKnowledgeProvider,
  KnowledgeEntry,
  LessonEntry,
  WikiEntry,
  DuplicateGroup,
} from "../types/provider";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, basename, extname } from "node:path";

const CACHE_TTL = 60_000;
const DUPLICATE_TIMEOUT = 5_000;
const MAX_FILES = 200; // Increased from 50 to improve duplicate detection coverage

const DEFAULT_CATEGORIES: Record<string, string[]> = {
  "01-技術主題": ["技術", "架構", "設計", "最佳實踐", "pattern", "原理"],
  "02-專案管理": ["專案", "進度", "規格", "需求"],
  "03-問題修復": ["修復", "bug", "error", "fix", "除錯", "問題"],
  "04-工具配置": ["安裝", "配置", "tool", "installer", "CLI", "設定"],
  "05-整合紀錄": ["整合", "deploy", "sync", "CI/CD", "部署"],
  "06-學習筆記": ["學習", "研究", "筆記", "tutorial", "心得"],
  "07-功能更新": ["新增", "更新", "feature", "changelog", "版本"],
  "08-討論決策": ["決策", "討論", "decision", "ADR", "選擇"],
  "09-記憶系統": ["記憶", "memory", "preference", "context", "偏好"],
};

const DEFAULT_SEVERITY: Record<string, string[]> = {
  "P0-嚴重翻車": ["崩潰", "資料損失", "刪除錯誤", "破壞", "無法啟動", "損壞"],
  "P1-功能錯誤": [
    "編譯失敗",
    "邏輯錯誤",
    "功能異常",
    "無法運作",
    "錯誤",
    "bug",
  ],
  "P2-效能問題": ["效能低落", "記憶體", "洩漏", "無限迴圈", "卡頓", "緩慢"],
  "P3-體驗不佳": ["體驗差", "缺少訊息", "錯位", "殘留", "混淆", "不直覺"],
  "P4-最佳實踐": ["優化", "最佳實踐", "更好的做法", "建議", "改進", "精簡"],
};

const mdCache = new Map<string, { files: string[]; ts: number }>();

export class FileProvider implements IKnowledgeProvider {
  private initialized = false;
  private dir = "";
  private cfg: Record<string, any> = {};
  private kbPath = "";
  private lessonPath = "";
  private wikiPath = "";
  private categories: Record<string, string[]> = { ...DEFAULT_CATEGORIES };
  private severity: Record<string, string[]> = { ...DEFAULT_SEVERITY };
  private dupThreshold = 0.85;

  getName() {
    return "file";
  }
  getVersion() {
    return "1.0.0";
  }
  isInitialized() {
    return this.initialized;
  }

  async init(opts: { dir: string; cfg: Record<string, any> }) {
    this.dir = opts.dir;
    this.cfg = opts.cfg;
    this.kbPath =
      opts.cfg.knowledgePath || join(this.dir, ".opencode/knowledge");
    this.lessonPath =
      opts.cfg.lessonPath || join(this.dir, ".opencode/lesson-learned");
    this.wikiPath = opts.cfg.wikiPath || join(this.dir, ".wiki");

    // Accept overrides from config
    if (opts.cfg.categories)
      this.categories = { ...this.categories, ...opts.cfg.categories };
    if (opts.cfg.severity)
      this.severity = { ...this.severity, ...opts.cfg.severity };
    if (typeof opts.cfg.duplicateThreshold === "number")
      this.dupThreshold = opts.cfg.duplicateThreshold;
    if (typeof opts.cfg.cacheTTL === "number") {
      /* keep default CACHE_TTL for now */
    }
    await Promise.all([
      mkdir(this.kbPath, { recursive: true }),
      mkdir(this.lessonPath, { recursive: true }),
      mkdir(this.wikiPath, { recursive: true }),
    ]);
    this.initialized = true;
  }

  // ══════════════════════════════════════════
  //  Internal helpers
  // ══════════════════════════════════════════

  private async listMarkdown(dir: string): Promise<string[]> {
    const now = Date.now();
    const cached = mdCache.get(dir);
    if (cached && now - cached.ts < CACHE_TTL) return cached.files;

    const files: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!["node_modules", ".git", "backups", "待審"].includes(entry.name))
            files.push(...(await this.listMarkdown(full)));
        } else if (extname(entry.name) === ".md") {
          files.push(full);
        }
      }
    } catch {
      /* ignore */
    }
    mdCache.set(dir, { files, ts: now });
    return files;
  }

  private extractWords(content: string): Set<string> {
    const words = new Set<string>();
    const tokens = content.split(
      /[\s\n\r\t,;.!?(){}[\]<>:"'`~@#$%^&*+=|\\/-]+/,
    );
    for (const t of tokens) {
      if (t.length > 1) words.add(t.toLowerCase());
    }
    return words;
  }

  private calcSim(a: Set<string>, b: Set<string>): number {
    const inter = new Set([...a].filter((w) => b.has(w)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 0 : inter.size / union.size;
  }

  autoClassify(content: string, title: string): string {
    const text = `${title} ${content}`.toLowerCase();
    let best = "01-技術主題";
    let bestScore = 0;
    for (const [cat, kws] of Object.entries(this.categories)) {
      let score = 0;
      for (const kw of kws) {
        if (text.includes(kw.toLowerCase())) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cat;
      }
    }
    return best;
  }

  detectSeverity(text: string): string {
    const lower = text.toLowerCase();
    for (const [level, kws] of Object.entries(this.severity)) {
      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase())) return level;
      }
    }
    return "P4-最佳實踐";
  }

  private genFilename(title: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const sanitized = title
      .replace(/[^\w\s\u4e00-\u9fff]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 40);
    return `${sanitized}-${date}.md`;
  }

  // ══════════════════════════════════════════
  //  Knowledge
  // ══════════════════════════════════════════

  async saveKnowledge(entry: KnowledgeEntry): Promise<string> {
    const catDir = join(this.kbPath, entry.category);
    await mkdir(catDir, { recursive: true });
    const filename = this.genFilename(entry.title);
    const filePath = join(catDir, filename);

    const content = `# ${entry.title}

> 分類：${entry.category}
> 日期：${entry.createdAt}
> 標籤：${entry.tags.join(", ")}
> 來源：${entry.source}

---

${entry.content}

---

## 元數據

- 建立日期：${entry.createdAt}
- 使用次數：${entry.useCount}
`;
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  async listKnowledge(
    category?: string,
    sortBy?: string,
    limit?: number,
  ): Promise<KnowledgeEntry[]> {
    const files = await this.listMarkdown(this.kbPath);
    const entries: KnowledgeEntry[] = [];

    for (const file of files) {
      if (category && !file.includes(category)) continue;
      const parsed = await this.parseKnowledgeFile(file);
      if (parsed) entries.push(parsed);
    }

    if (sortBy === "title")
      entries.sort((a, b) => a.title.localeCompare(b.title));
    else entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return entries.slice(0, limit || 50);
  }

  async readKnowledge(
    title: string,
    category?: string,
  ): Promise<KnowledgeEntry | null> {
    const files = await this.listMarkdown(this.kbPath);
    const query = title.toLowerCase();
    for (const file of files) {
      if (category && !file.includes(category)) continue;
      const parsed = await this.parseKnowledgeFile(file);
      if (parsed && parsed.title.toLowerCase().includes(query)) return parsed;
    }
    return null;
  }

  async deleteKnowledge(id: string): Promise<void> {
    try {
      await rm(id);
    } catch {
      /* ignore */
    }
  }

  private async parseKnowledgeFile(
    file: string,
  ): Promise<KnowledgeEntry | null> {
    try {
      const content = await readFile(file, "utf8");
      const title = content.match(/^# (.+)$/m)?.[1] || basename(file);
      const category = content.match(/> 分類：(.+)$/m)?.[1] || "未分類";
      const date = content.match(/> 日期：(.+)$/m)?.[1] || "";
      const tags = content.match(/> 標籤：(.+)$/m)?.[1] || "";
      const source = content.match(/> 來源：(.+)$/m)?.[1] || "";
      const useCount = parseInt(content.match(/使用次數：(\d+)/)?.[1] || "0");

      return {
        id: file,
        title,
        content,
        category,
        tags: tags.split(", ").filter(Boolean),
        source,
        createdAt: date,
        updatedAt: date,
        useCount,
      };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════
  //  Lessons
  // ══════════════════════════════════════════

  async saveLesson(entry: LessonEntry): Promise<string> {
    const catDir = join(this.lessonPath, entry.severity);
    await mkdir(catDir, { recursive: true });
    const filename = this.genFilename(entry.title);
    const filePath = join(catDir, filename);

    const content = `# [教訓] ${entry.title}

> 等級：${entry.severity}
> 日期：${entry.createdAt}
> 標籤：${entry.tags.join(", ")}

---

## 情境

${entry.scenario}

## 錯誤做法

${entry.mistake}

## 造成後果

${entry.consequence || "未記錄"}

## 正確做法

${entry.solution}

## 預防措施

${entry.prevention || "定期檢視相關程式碼，執行前確認路徑和參數"}

---

## 元數據

- 記錄日期：${entry.createdAt}
- 觸發次數：${entry.triggerCount}
- 狀態：${entry.status}
`;
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  async listLessons(severity?: string): Promise<LessonEntry[]> {
    const cats = severity ? [severity] : Object.keys(this.severity);
    const entries: LessonEntry[] = [];

    for (const cat of cats) {
      const dir = join(this.lessonPath, cat);
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
        for (const file of files) {
          const parsed = await this.parseLessonFile(join(dir, file));
          if (parsed) entries.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return entries;
  }

  private async parseLessonFile(file: string): Promise<LessonEntry | null> {
    try {
      const content = await readFile(file, "utf8");
      const title = content.match(/^# \[教訓\] (.+)$/m)?.[1] || basename(file);
      const severity = content.match(/> 等級：(.+)$/m)?.[1] || "P4-最佳實踐";
      const date = content.match(/> 日期：(.+)$/m)?.[1] || "";
      const tags = content.match(/> 標籤：(.+)$/m)?.[1] || "";
      const scenario = content.match(/## 情境\n\n([\s\S]*?)\n\n## /)?.[1] || "";
      const mistake =
        content.match(/## 錯誤做法\n\n([\s\S]*?)\n\n## /)?.[1] || "";
      const consequence =
        content.match(/## 造成後果\n\n([\s\S]*?)\n\n## /)?.[1] || "";
      const solution =
        content.match(/## 正確做法\n\n([\s\S]*?)\n\n## /)?.[1] || "";
      const prevention =
        content.match(/## 預防措施\n\n([\s\S]*?)\n\n---/)?.[1] || "";
      const triggerCount = parseInt(
        content.match(/觸發次數：(\d+)/)?.[1] || "0",
      );
      const status =
        (content.match(/狀態：(\w+)/)?.[1] as "active" | "archived") ||
        "active";

      return {
        id: file,
        title,
        scenario,
        mistake,
        consequence,
        solution,
        prevention,
        severity,
        tags: tags.split(", ").filter(Boolean),
        createdAt: date,
        triggerCount,
        status,
      };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════
  //  Wiki
  // ══════════════════════════════════════════

  async saveWiki(entry: WikiEntry): Promise<string> {
    const catDir = join(this.wikiPath, entry.category);
    await mkdir(catDir, { recursive: true });
    const filename = this.genFilename(entry.title);
    const filePath = join(catDir, filename);

    const content = `# ${entry.title}

> 分類：${entry.category}
> 日期：${entry.createdAt}
> 標籤：${entry.tags.join(", ")}

---

${entry.content}

---

## 元數據

- 建立日期：${entry.createdAt}
- 最後更新：${entry.updatedAt}
- 使用次數：${entry.useCount}
`;
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  async listWiki(category?: string, limit?: number): Promise<WikiEntry[]> {
    const files = await this.listMarkdown(this.wikiPath);
    const entries: WikiEntry[] = [];

    for (const file of files) {
      if (category && !file.includes(category)) continue;
      const parsed = await this.parseWikiFile(file);
      if (parsed) entries.push(parsed);
    }

    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return entries.slice(0, limit || 50);
  }

  async readWiki(title: string, category?: string): Promise<WikiEntry | null> {
    const files = await this.listMarkdown(this.wikiPath);
    const query = title.toLowerCase();
    for (const file of files) {
      if (category && !file.includes(category)) continue;
      const parsed = await this.parseWikiFile(file);
      if (parsed && parsed.title.toLowerCase().includes(query)) return parsed;
    }
    return null;
  }

  private async parseWikiFile(file: string): Promise<WikiEntry | null> {
    try {
      const content = await readFile(file, "utf8");
      const title = content.match(/^# (.+)$/m)?.[1] || basename(file);
      const category = content.match(/> 分類：(.+)$/m)?.[1] || "未分類";
      const date = content.match(/> 日期：(.+)$/m)?.[1] || "";
      const tags = content.match(/> 標籤：(.+)$/m)?.[1] || "";
      const useCount = parseInt(content.match(/使用次數：(\d+)/)?.[1] || "0");

      return {
        id: file,
        title,
        content,
        category,
        tags: tags.split(", ").filter(Boolean),
        createdAt: date,
        updatedAt: date,
        useCount,
      };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════
  //  Utility
  // ══════════════════════════════════════════

  async checkDuplicate(
    base: string,
    content: string,
    threshold?: number,
  ): Promise<{ file: string; similarity: number } | null> {
    const t = threshold ?? this.dupThreshold;
    const start = Date.now();
    const dir = base || this.kbPath;
    const files = await this.listMarkdown(dir);
    const cw = this.extractWords(content);
    const limited = files.slice(0, MAX_FILES);

    for (const file of limited) {
      if (Date.now() - start > DUPLICATE_TIMEOUT) break;
      try {
        const existing = await readFile(file, "utf8");
        const sim = this.calcSim(cw, this.extractWords(existing));
        if (sim >= t) return { file, similarity: sim };
      } catch {
        continue;
      }
    }
    return null;
  }

  async deduplicate(
    threshold: number,
    dryRun: boolean,
  ): Promise<{ groups: DuplicateGroup[]; removed: number }> {
    const files = await this.listMarkdown(this.kbPath);
    const contents: Array<{ file: string; words: Set<string> }> = [];

    for (const file of files) {
      try {
        const content = await readFile(file, "utf8");
        contents.push({ file, words: this.extractWords(content) });
      } catch {
        continue;
      }
    }

    const groups: DuplicateGroup[] = [];
    const removed = new Set<string>();

    for (let i = 0; i < contents.length; i++) {
      if (removed.has(contents[i].file)) continue;
      const remove: string[] = [];
      let maxSim = 0;

      for (let j = i + 1; j < contents.length; j++) {
        if (removed.has(contents[j].file)) continue;
        const sim = this.calcSim(contents[i].words, contents[j].words);
        if (sim >= threshold) {
          remove.push(contents[j].file);
          removed.add(contents[j].file);
          maxSim = Math.max(maxSim, sim);
        }
      }

      if (remove.length > 0) {
        groups.push({
          keep: contents[i].file,
          remove,
          similarity: maxSim,
        });
      }
    }

    let removedCount = 0;
    if (!dryRun) {
      for (const g of groups) {
        for (const f of g.remove) {
          try {
            await rm(f);
            removedCount++;
          } catch {
            /* skip */
          }
        }
      }
    }

    return { groups, removed: dryRun ? 0 : removedCount };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await mkdir(this.kbPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    mdCache.clear();
    this.initialized = false;
  }
}
