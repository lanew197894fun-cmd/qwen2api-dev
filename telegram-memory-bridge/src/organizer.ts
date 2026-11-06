// Telegram Memory Bridge — organizer.ts
// 舊資料自動分類 → SOP 生成 + 進度追蹤
// 掃描記憶/知識庫/維基，AI 判斷哪些值得做成 SOP，自動寫入 wiki

import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync, renameSync } from "fs";
import { resolve, dirname, relative } from "path";
import type { MemStore } from "./store.ts";

// ── 型別 ──

export interface OrgProgress {
  running: boolean;
  phase: string; // idle / scanning-memory / scanning-knowledge / classifying / generating / done
  total: number;
  scanned: number;
  sopCreated: number;
  sopUpdated: number;
  skipped: number;
  errors: number;
  startedAt: string;
  updatedAt: string;
  log: string[];
}

export interface OrgPaths {
  wikiDir: string;
  wikiIndex: string;
  knowledgeDir: string;
  progressPath: string;
}

const IGNORE_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const SOP_DIR = "00-未歸類-SOP";

// ── 組織器 ──

export class OrgEngine {
  private store: MemStore;
  private paths: OrgPaths;
  private progress: OrgProgress;
  private qwenAsk: (sys: string, msg: string) => Promise<string>;

  constructor(
    store: MemStore,
    paths: OrgPaths,
    qwenAsk: (sys: string, msg: string) => Promise<string>,
  ) {
    this.store = store;
    this.paths = paths;
    this.qwenAsk = qwenAsk;
    this.progress = {
      running: false,
      phase: "idle",
      total: 0,
      scanned: 0,
      sopCreated: 0,
      sopUpdated: 0,
      skipped: 0,
      errors: 0,
      startedAt: "",
      updatedAt: "",
      log: [],
    };
  }

  getProgress(): OrgProgress {
    return { ...this.progress };
  }

  isRunning(): boolean {
    return this.progress.running;
  }

  // ── 載入/儲存進度 ──

  private async loadProgress(): Promise<void> {
    try {
      const raw = await readFile(this.paths.progressPath, "utf-8");
      const p = JSON.parse(raw) as OrgProgress;
      if (!p.running) this.progress = { ...this.progress, ...p };
    } catch {
      /* 首次使用無舊進度 */
    }
  }

  private async saveProgress(): Promise<void> {
    this.progress.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.paths.progressPath), { recursive: true });
    const tmp = this.paths.progressPath + ".tmp." + process.pid;
    await writeFile(tmp, JSON.stringify(this.progress, null, 2), "utf-8");
    renameSync(tmp, this.paths.progressPath);
  }

  private log(msg: string): void {
    this.progress.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (this.progress.log.length > 100)
      this.progress.log = this.progress.log.slice(-100);
    console.log(`[organizer] ${msg}`);
  }

  // ── Heuristic 預檢查：強制 SOP ──
  // 先避開 AI 猶豫，只要內容有技術特徵直接判定為 SOP

  private heuristicCheck(
    title: string,
    content: string,
  ): {
    isSop: boolean;
    category: string;
  } | null {
    const lower = content.toLowerCase();
    const codeBlock = content.includes("```");
    const commands = /(`[a-z]+\s+[^\n`]+`)/.test(content);
    const numberedSteps = /^\d+\.\s/m.test(content);
    const hasConfig =
      lower.includes("設定") ||
      lower.includes("config") ||
      lower.includes("安裝");
    const hasFix =
      lower.includes("修復") ||
      lower.includes("修復") ||
      lower.includes("bug") ||
      lower.includes("錯誤");
    const hasSteps =
      lower.includes("步驟") ||
      lower.includes("step") ||
      lower.includes("流程");
    const hasTool = /`[a-z-]+`/.test(content); // backtick tool names

    // 程式碼區塊 → 必為 SOP
    if (codeBlock) return { isSop: true, category: "技術主題" };
    // 步驟+指令 → 問題修復
    if (numberedSteps && hasFix) return { isSop: true, category: "問題修復" };
    // 指令+配置 → 工具配置
    if (commands && hasConfig) return { isSop: true, category: "工具配置" };
    // 步驟+工具 → 系統維護
    if (hasSteps && hasTool) return { isSop: true, category: "系統維護" };
    // 修復關鍵字出現 ≥2 次 → 問題修復
    if ((content.match(/修復/g) || []).length >= 2)
      return { isSop: true, category: "問題修復" };

    return null; // 無法用 heuristic 判斷，交給 AI
  }

  // ── AI 分類：是否值得做成 SOP（heuristic 已過濾後才進來）──

  private async classifyForSOP(
    title: string,
    content: string,
    source: string,
  ): Promise<{
    isSop: boolean;
    category: string;
    confidence: number;
    reason: string;
  }> {
    const preview = content.slice(0, 1500);
    const system = [
      "你是一個知識組織助手。分析以下內容，判斷是否值得製作成標準作業程序（SOP）。",
      "",
      "SOP 的典型特徵：",
      "- 包含具體步驟/流程（修復步驟、安裝步驟、配置流程）",
      "- 解決特定問題的方法（bug 修復、錯誤排查）",
      "- 可重複執行的操作（部署、測試、同步）",
      "- 工具/指令的使用方式",
      "",
      "不值得做 SOP 的內容：",
      "- 純問候/閒聊",
      "- 個人偏好/習慣（非技術性）",
      "- 過於籠統的概念描述",
      "- 已經過時的資訊",
      "",
      "💡 不確定的時候，直接回傳 isSop=true，category 設 00-未歸類。",
      "寧可多建也不要錯過，分類錯了以後可以歸類。",
      "",
      "回傳 JSON，格式：",
      '{"isSop": true/false, "category": "系統維護/問題修復/技術主題/工具配置/整合紀錄", "confidence": 0-100, "reason": "簡短原因"}',
    ].join("\n");

    const prompt = [
      `來源: ${source}`,
      `標題: ${title}`,
      ``,
      `內容預覽:`,
      preview,
      ``,
      "請分析是否值得做成 SOP。不確定就回 true，category 設 00-未歸類。",
    ].join("\n");

    try {
      const answer = await this.qwenAsk(system, prompt);
      const cleaned = answer
        .replace(/```(?:json)?\n?/g, "")
        .replace(/\n?```/g, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1)
        return {
          isSop: true,
          category: "00-未歸類",
          confidence: 50,
          reason: "分類失敗，歸未歸類",
        };
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return {
        isSop: true,
        category: "00-未歸類",
        confidence: 50,
        reason: "AI 錯誤，歸未歸類",
      };
    }
  }

  // ── SOP 生成 ──

  private async generateSOP(
    title: string,
    content: string,
    source: string,
    category: string,
  ): Promise<string> {
    const system = [
      "你是一個 SOP 撰寫助手。根據提供的原始內容，生成標準作業程序（SOP）文件。",
      "",
      "SOP 格式要求（Markdown）：",
      "# SOP: <標題> v1",
      "",
      "## 問題描述",
      "（簡述問題與背景）",
      "",
      "## 適用情境",
      "（什麼時候使用此 SOP）",
      "",
      "## 排查步驟",
      "1. ...",
      "2. ...",
      "",
      "## 修復/執行方式",
      "- ...",
      "",
      "## 環境變數 / 配置",
      "| 參數 | 預設值 | 說明 |",
      "",
      "## 相關檔案",
      "- ...",
      "",
      "## 版本記錄",
      "- **YYYY-MM-DD**: 初始版本",
      "",
      "保留所有技術細節，移除個人語氣，使用繁體中文。",
      "內容要簡潔、步驟要清晰、讓 AI 或人類都能照做。",
    ].join("\n");

    const prompt = [
      `原始來源: ${source}`,
      `分類: ${category}`,
      ``,
      `原始內容:`,
      content.slice(0, 3000),
      ``,
      "請生成 SOP。",
    ].join("\n");

    try {
      return await this.qwenAsk(system, prompt);
    } catch {
      return (
        `# SOP: ${title} v1\n\n` +
        `## 問題描述\n\n${content.slice(0, 500)}\n\n` +
        `## 來源\n\n- ${source}\n\n` +
        `## 版本記錄\n\n- **${new Date().toISOString().slice(0, 10)}**: 初始版本（自動生成）`
      );
    }
  }

  // ── 掃描記憶 ──

  private async scanMemory(): Promise<number> {
    const entries = await this.store.list();
    this.log(`📖 記憶: ${entries.length} 筆`);
    let created = 0;

    for (const entry of entries) {
      if (!this.progress.running) break;
      this.progress.scanned++;

      // 讀取完整內容
      const full = await this.store.readContent(entry.id);
      if (!full) {
        this.progress.skipped++;
        continue;
      }

      // Heuristic 預檢 → 不過關才給 AI（減少等待）
      const h = this.heuristicCheck(entry.summary, full);
      let cls;
      if (h) {
        cls = { ...h, confidence: 90, reason: "heuristic 匹配" };
      } else {
        cls = await this.classifyForSOP(
          entry.summary,
          full,
          `memory/${entry.id}`,
        );
      }

      if (cls.isSop) {
        const sopPath = resolve(
          this.paths.wikiDir,
          SOP_DIR,
          `${slugify(entry.summary).slice(0, 50)}.md`,
        );

        // 檢查是否已存在
        if (existsSync(sopPath)) {
          this.progress.sopUpdated++;
          this.log(`🔄 SOP 已存在: ${entry.summary.slice(0, 40)}`);
        } else {
          const sop = await this.generateSOP(
            entry.summary,
            full,
            `memory/${entry.id}`,
            cls.category,
          );
          await mkdir(dirname(sopPath), { recursive: true });
          await writeFile(sopPath, sop, "utf-8");
          this.progress.sopCreated++;
          created++;
          this.log(`📝 新建 SOP: ${entry.summary.slice(0, 40)}`);
        }
      } else {
        this.progress.skipped++;
      }

      // 每 5 筆存一次進度
      if (this.progress.scanned % 5 === 0) await this.saveProgress();
    }

    return created;
  }

  // ── 掃描知識庫 ──

  private async walkDir(base: string, prefix: string): Promise<string[]> {
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
          /* skip */
        }
      }
    };
    await walk(base);
    return files;
  }

  private async scanKnowledge(): Promise<number> {
    const files = await this.walkDir(this.paths.knowledgeDir, "");
    this.log(`📚 知識庫: ${files.length} 個檔案`);
    let created = 0;

    for (const fullPath of files) {
      if (!this.progress.running) break;
      this.progress.scanned++;

      let content: string;
      try {
        content = await readFile(fullPath, "utf-8");
      } catch {
        this.progress.errors++;
        continue;
      }

      const relPath = relative(this.paths.knowledgeDir, fullPath);
      const title = extractTitle(content) || relPath.replace(/\.md$/, "");
      const isAlreadySop =
        content.includes("# SOP:") || content.includes("## 問題描述");

      if (isAlreadySop) {
        // 已 SOP 格式的知識 → 確認在 wiki 目錄有對應
        const sopPath = resolve(this.paths.wikiDir, SOP_DIR, relPath);
        if (!existsSync(sopPath)) {
          await mkdir(dirname(sopPath), { recursive: true });
          await writeFile(sopPath, content, "utf-8");
          this.progress.sopCreated++;
          created++;
          this.log(`📎 連結現有 SOP: ${title.slice(0, 40)}`);
        }
        continue;
      }

      // Heuristic 預檢 → 不過關才給 AI
      const h = this.heuristicCheck(title, content);
      let cls;
      if (h) {
        cls = { ...h, confidence: 90, reason: "heuristic 匹配" };
      } else {
        cls = await this.classifyForSOP(title, content, `knowledge/${relPath}`);
      }

      if (cls.isSop) {
        const sopPath = resolve(
          this.paths.wikiDir,
          SOP_DIR,
          `${slugify(title).slice(0, 50)}.md`,
        );
        if (existsSync(sopPath)) {
          this.progress.sopUpdated++;
        } else {
          const sop = await this.generateSOP(
            title,
            content,
            `knowledge/${relPath}`,
            cls.category,
          );
          await mkdir(dirname(sopPath), { recursive: true });
          await writeFile(sopPath, sop, "utf-8");
          this.progress.sopCreated++;
          created++;
          this.log(`📝 新建 SOP: ${title.slice(0, 40)}`);
        }
      } else {
        this.progress.skipped++;
      }

      if (this.progress.scanned % 5 === 0) await this.saveProgress();
    }

    return created;
  }

  // ── 主入口 ──

  async start(): Promise<string> {
    if (this.progress.running) return "⏳ 整理工作已在進行中";

    await this.loadProgress();
    this.progress.running = true;
    this.progress.phase = "counting";
    this.progress.startedAt = new Date().toISOString();
    this.progress.total = 0;
    this.progress.scanned = 0;
    this.progress.sopCreated = 0;
    this.progress.sopUpdated = 0;
    this.progress.skipped = 0;
    this.progress.errors = 0;
    this.progress.log = [];
    await this.saveProgress();

    this.log("🚀 開始整理舊資料");

    // 預先計算總數（修正 /progress total 顯示）
    const entries = await this.store.list();
    const knwFiles = await this.walkDir(this.paths.knowledgeDir, "");
    this.progress.total = entries.length + knwFiles.length;
    this.log(
      `📊 預計掃描: 記憶 ${entries.length} 筆 + 知識庫 ${knwFiles.length} 個檔案`,
    );
    await this.saveProgress();

    // Phase 1: 記憶
    this.progress.phase = "scanning-memory";
    await this.saveProgress();
    const memCreated = await this.scanMemory();

    if (!this.progress.running) {
      this.log("⏹ 已暫停");
      this.progress.phase = "paused";
      await this.saveProgress();
      return "⏹ 整理已暫停";
    }

    // Phase 2: 知識庫
    this.progress.phase = "scanning-knowledge";
    await this.saveProgress();
    const knwCreated = await this.scanKnowledge();

    // Phase 3: 更新索引
    this.progress.phase = "indexing";
    await this.saveProgress();

    // 完成
    this.progress.running = false;
    this.progress.phase = "done";
    const elapsed = Math.round(
      (Date.now() - new Date(this.progress.startedAt).getTime()) / 1000,
    );
    await this.saveProgress();

    const summary = [
      `✅ 整理完成 (${elapsed}s)`,
      `📖 掃描: ${this.progress.scanned} 筆`,
      `📝 新建 SOP: ${this.progress.sopCreated} 個`,
      `🔄 更新 SOP: ${this.progress.sopUpdated} 個`,
      `⏭ 跳過: ${this.progress.skipped} 筆`,
      `❌ 錯誤: ${this.progress.errors} 個`,
    ].join("\n");

    this.log(summary);
    return summary;
  }

  async stop(): Promise<void> {
    this.progress.running = false;
    this.progress.phase = "stopped";
    await this.saveProgress();
    this.log("⏹ 整理已停止（排隊作業完成後生效）");
  }
}

// ── 工具函數 ──

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
