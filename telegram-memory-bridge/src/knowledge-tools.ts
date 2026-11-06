// Telegram Memory Bridge — knowledge-tools.ts
// 橋接 knowledge-wiki-plugin 的 FileProvider，供 Telegram bot 使用

import { resolve } from "path";
import { readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { FileProvider } from "../../knowledge-wiki-plugin/src/provider/file-provider.ts";
// 使用集中管理的跨裝置路徑
import {
  OPENCODE_DIR,
  KNOWLEDGE_DIR,
  WIKI_DIR,
  LESSON_DIR,
} from "../../config/paths.js";

let provider: FileProvider | null = null;
let initialized = false;
let initializing = false;

export async function initKnowledgeTools(
  dir: string,
  knowledgePath?: string,
  wikiPath?: string,
  lessonPath?: string,
) {
  if (initialized) return;
  if (initializing) {
    // 等待其他請求完成初始化
    while (initializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  initializing = true;
  try {
    const kbPath = knowledgePath || KNOWLEDGE_DIR;
    const wkPath = wikiPath || WIKI_DIR;
    const lsPath = lessonPath || LESSON_DIR;

    provider = new FileProvider();
    await provider.init({
      dir,
      cfg: {
        knowledgePath: kbPath,
        wikiPath: wkPath,
        lessonPath: lsPath,
      },
    });
    initialized = true;
  } catch (err) {
    console.error("[knowledge-tools] 初始化失敗:", (err as Error).message);
    throw err;
  } finally {
    initializing = false;
  }
}

async function getProvider(): Promise<FileProvider> {
  if (!provider) {
    // Lazy init: 嘗試自動初始化（使用預設路徑）
    console.warn("[knowledge-tools] Provider 未初始化，嘗試自動初始化...");
    const defaultDir = resolve(__dirname, "..");
    try {
      await initKnowledgeTools(defaultDir);
    } catch (err) {
      console.error(
        "[knowledge-tools] 自動初始化失敗:",
        (err as Error).message,
      );
      throw new Error("Knowledge tools initialization failed");
    }
  }
  if (!provider) {
    throw new Error("Knowledge tools not initialized after retry");
  }
  return provider;
}

// ── Knowledge tools ──

export async function knowledgeSave(args: Record<string, string>) {
  const p = await getProvider();
  const title = args.title || "untitled";
  const content = args.content || "";
  if (!content) return { ok: false, output: "", error: "content required" };

  const dup = await p.checkDuplicate("", content);
  if (dup) {
    return {
      ok: true,
      output: `🔄 知識已存在（相似度 ${(dup.similarity * 100).toFixed(1)}%）: ${dup.file}`,
    };
  }

  const category = args.category || p.autoClassify(content, title);
  const path = await p.saveKnowledge({
    id: "",
    title,
    content,
    category,
    tags: (args.tags || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    source: args.source || "telegram",
    createdAt: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
    useCount: 0,
  });
  return { ok: true, output: `✅ 知識已儲存\n📁 ${category}\n📄 ${path}` };
}

export async function knowledgeRead(args: Record<string, string>) {
  const p = await getProvider();
  const title = args.title || "";
  if (!title) return { ok: false, output: "", error: "title required" };

  const entry = await p.readKnowledge(title, args.category);
  if (!entry) return { ok: true, output: `📭 未找到: "${title}"` };
  return {
    ok: true,
    output: `# ${entry.title}\n\n${entry.content.slice(0, 3000)}`,
  };
}

export async function knowledgeIndex(args: Record<string, string>) {
  const p = await getProvider();
  const entries = await p.listKnowledge(
    args.category,
    args.sortBy || "date",
    parseInt(args.limit || "20"),
  );
  if (entries.length === 0) return { ok: true, output: "📭 知識庫為空" };
  const lines = entries.map(
    (e: any, i: number) =>
      `${i + 1}. ${e.title} [${e.category}] ${e.createdAt}`,
  );
  return {
    ok: true,
    output: `📚 知識庫 (${entries.length})\n\n${lines.join("\n")}`,
  };
}

export async function knowledgeDeduplicate(args: Record<string, string>) {
  const p = await getProvider();
  const threshold = parseFloat(args.threshold || "0.9");
  const dryRun = args.dryRun !== "false";
  const { groups } = await p.deduplicate(threshold, dryRun);
  if (groups.length === 0) return { ok: true, output: "✅ 未發現重複" };
  let out = `🔍 ${groups.length} 組重複\n\n`;
  for (const g of groups) {
    out += `保留: ${g.keep}\n  相似度: ${(g.similarity * 100).toFixed(1)}%\n`;
  }
  if (dryRun) out += "\n💡 預覽模式，加 dryRun=false 執行刪除";
  return { ok: true, output: out };
}

// ── Lesson tools ──

export async function lessonSave(args: Record<string, string>) {
  const p = await getProvider();
  const title = args.title || "untitled";
  const text = `${title} ${args.scenario || ""} ${args.mistake || ""}`;
  const severity = args.severity || p.detectSeverity(text);

  const dup = await p.checkDuplicate("", text);
  if (dup) {
    return {
      ok: true,
      output: `🔄 教訓已存在（${(dup.similarity * 100).toFixed(1)}%）`,
    };
  }

  await p.saveLesson({
    id: "",
    title,
    scenario: args.scenario || "",
    mistake: args.mistake || "",
    consequence: args.consequence || "",
    solution: args.solution || "",
    prevention: args.prevention || "",
    severity,
    tags: (args.tags || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    createdAt: new Date().toISOString().slice(0, 10),
    triggerCount: 0,
    status: "active",
  });
  return { ok: true, output: `✅ 教訓已儲存（${severity}）` };
}

export async function lessonList(args: Record<string, string>) {
  const p = await getProvider();
  const entries = await p.listLessons(args.severity);
  if (entries.length === 0) return { ok: true, output: "📭 尚無教訓" };
  const lines = entries.map(
    (e: any) => `[${e.severity}] ${e.title} (${e.createdAt})`,
  );
  return {
    ok: true,
    output: `📚 教訓 (${entries.length})\n\n${lines.join("\n")}`,
  };
}

// ── Wiki tools ──

export async function wikiSave(args: Record<string, string>) {
  const p = await getProvider();
  const title = args.title || "untitled";
  const content = args.content || "";
  if (!content) return { ok: false, output: "", error: "content required" };

  const category = args.category || p.autoClassify(content, title);
  const path = await p.saveWiki({
    id: "",
    title,
    content,
    category,
    tags: (args.tags || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    createdAt: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
    useCount: 0,
  });
  return { ok: true, output: `✅ 維基已儲存\n📁 ${category}\n📄 ${path}` };
}

export async function wikiList(args: Record<string, string>) {
  const p = await getProvider();
  const entries = await p.listWiki(args.category, parseInt(args.limit || "20"));
  if (entries.length === 0) return { ok: true, output: "📭 維基為空" };
  const lines = entries.map(
    (e: any, i: number) =>
      `${i + 1}. ${e.title} [${e.category}] ${e.createdAt}`,
  );
  return {
    ok: true,
    output: `📖 維基 (${entries.length})\n\n${lines.join("\n")}`,
  };
}

export async function wikiRead(args: Record<string, string>) {
  const p = await getProvider();
  const title = args.title || "";
  if (!title) return { ok: false, output: "", error: "title required" };
  const entry = await p.readWiki(title, args.category);
  if (!entry) return { ok: true, output: `📭 未找到: "${title}"` };
  return {
    ok: true,
    output: `# ${entry.title}\n\n${entry.content.slice(0, 3000)}`,
  };
}

// ── Tool router for knowledge commands ──

export type KnowledgeToolName =
  | "knowledge_save"
  | "knowledge_read"
  | "knowledge_index"
  | "knowledge_deduplicate"
  | "lesson_save"
  | "lesson_list"
  | "wiki_save"
  | "wiki_list"
  | "wiki_read";

export const KNOWLEDGE_TOOLS: Record<
  KnowledgeToolName,
  (
    args: Record<string, string>,
  ) => Promise<{ ok: boolean; output: string; error?: string }>
> = {
  knowledge_save: knowledgeSave,
  knowledge_read: knowledgeRead,
  knowledge_index: knowledgeIndex,
  knowledge_deduplicate: knowledgeDeduplicate,
  lesson_save: lessonSave,
  lesson_list: lessonList,
  wiki_save: wikiSave,
  wiki_list: wikiList,
  wiki_read: wikiRead,
};

export const KNOWLEDGE_TOOL_NAMES = Object.keys(
  KNOWLEDGE_TOOLS,
) as KnowledgeToolName[];
