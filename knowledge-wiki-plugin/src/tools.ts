// Tool definitions for knowledge-wiki-plugin

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { providerManager } from "./provider-manager";

function provPath(prov: any, key: string): string {
  return typeof prov[key] === "string" ? prov[key] : "";
}

export function getTools() {
  const p = () => providerManager.get();

  return {
    "knowledge/save": tool({
      description: "儲存知識到知識庫，自動分類、檢查重複",
      args: {
        title: z.string().describe("知識標題"),
        content: z.string().describe("知識內容"),
        category: z.string().optional().describe("指定分類（可選，自動判斷）"),
        tags: z.array(z.string()).optional().describe("標籤列表"),
        source: z.string().optional().describe("來源"),
      },
      async execute(args) {
        const prov = p();
        const base = provPath(prov, "kbPath");
        const dup = await prov.checkDuplicate(base, args.content);
        if (dup) {
          return `🔄 知識已存在，相似度 ${(dup.similarity * 100).toFixed(1)}%：${dup.file}`;
        }

        const entry = {
          id: "",
          title: args.title,
          content: args.content,
          category:
            args.category ||
            ("autoClassify" in prov
              ? (prov as any).autoClassify(args.content, args.title)
              : "01-技術主題"),
          tags: args.tags || [],
          source: args.source || "ai-auto",
          createdAt: new Date().toISOString().slice(0, 10),
          updatedAt: new Date().toISOString().slice(0, 10),
          useCount: 0,
        };
        const path = await prov.saveKnowledge(entry);
        return `✅ 知識已儲存\n📁 分類：${entry.category}\n📄 檔案：${basename(path)}`;
      },
    }),

    "lesson/save": tool({
      description: "記錄經驗教訓，預防重複犯錯",
      args: {
        title: z.string().describe("教訓標題"),
        scenario: z.string().describe("發生情境"),
        mistake: z.string().describe("錯誤做法"),
        consequence: z.string().optional().describe("造成後果"),
        solution: z.string().describe("正確做法"),
        prevention: z.string().optional().describe("預防措施"),
        severity: z.string().optional().describe("嚴重等級 P0-P4"),
        tags: z.array(z.string()).optional().describe("標籤"),
      },
      async execute(args) {
        const prov = p();
        const text = `${args.title} ${args.scenario} ${args.mistake}`;
        const severity =
          args.severity ||
          ("detectSeverity" in prov
            ? (prov as any).detectSeverity(text)
            : "P4-最佳實踐");

        const dup = await prov.checkDuplicate(
          provPath(prov, "lessonPath"),
          text,
        );
        if (dup)
          return `🔄 教訓已存在，相似度 ${(dup.similarity * 100).toFixed(1)}%：${dup.file}`;

        const entry = {
          id: "",
          title: args.title,
          scenario: args.scenario,
          mistake: args.mistake,
          consequence: args.consequence || "",
          solution: args.solution,
          prevention: args.prevention || "",
          severity,
          tags: args.tags || [],
          createdAt: new Date().toISOString().slice(0, 10),
          triggerCount: 0,
          status: "active" as const,
        };
        const path = await prov.saveLesson(entry);
        return `✅ 教訓已儲存\n📁 等級：${severity}\n📄 檔案：${basename(path)}`;
      },
    }),

    "wiki/save": tool({
      description: "儲存維基條目",
      args: {
        title: z.string().describe("維基標題"),
        content: z.string().describe("維基內容"),
        category: z.string().optional().describe("分類"),
        tags: z.array(z.string()).optional().describe("標籤"),
      },
      async execute(args) {
        const prov = p();
        const category =
          args.category ||
          ("autoClassify" in prov
            ? (prov as any).autoClassify(args.content, args.title)
            : "01-技術主題");

        const entry = {
          id: "",
          title: args.title,
          content: args.content,
          category,
          tags: args.tags || [],
          createdAt: new Date().toISOString().slice(0, 10),
          updatedAt: new Date().toISOString().slice(0, 10),
          useCount: 0,
        };
        const path = await prov.saveWiki(entry);
        return `✅ 維基已儲存\n📁 分類：${category}\n📄 檔案：${basename(path)}`;
      },
    }),

    "knowledge/index": tool({
      description: "索引預覽 - 快速瀏覽所有知識條目概覽（表格視圖，輕量快速）",
      args: {
        category: z.string().optional().describe("限定分類"),
        sortBy: z
          .enum(["date", "title"])
          .optional()
          .describe("排序方式：date=日期、title=標題"),
        limit: z.number().optional().describe("限制數量"),
      },
      async execute(args) {
        const prov = p();
        const entries = await prov.listKnowledge(
          args.category,
          args.sortBy === "title" ? "title" : "date",
          args.limit,
        );

        if (entries.length === 0) return "📭 知識庫為空";

        let output = `📚 知識索引 (${entries.length} 筆)\n`;
        output += "═".repeat(70) + "\n";
        output += `${"標題".padEnd(20)} | ${"分類".padEnd(12)} | ${"日期".padEnd(10)} | ${"標籤".padEnd(15)}\n`;
        output += "─".repeat(70) + "\n";

        for (const e of entries) {
          const shortTitle =
            e.title.length > 18 ? e.title.slice(0, 18) + ".." : e.title;
          const shortTags =
            e.tags.join(", ").length > 13
              ? e.tags.join(", ").slice(0, 13) + ".."
              : e.tags.join(", ");
          output += `${shortTitle.padEnd(20)} | ${e.category.slice(0, 10).padEnd(12)} | ${e.createdAt.padEnd(10)} | ${shortTags.padEnd(15)}\n`;
        }

        output += "═".repeat(70) + "\n";
        if (args.category) output += `\n📂 分類：${args.category}`;
        output += `\n💡 使用 knowledge/read <標題> 閱讀完整內容`;
        return output;
      },
    }),

    "knowledge/read": tool({
      description: "閱覽功能 - 完整閱讀知識條目（豐富格式，適合深度閱讀）",
      args: {
        title: z.string().describe("知識標題（或部分標題）"),
        category: z.string().optional().describe("限定分類搜尋"),
      },
      async execute(args) {
        const prov = p();
        const entry = await prov.readKnowledge(args.title, args.category);

        if (!entry) return `📭 未找到知識：「${args.title}」`;

        const mainContent = entry.content
          .replace(/^> .+$/gm, "")
          .replace(/^---$/gm, "")
          .replace(/^## 元數據[\s\S]*$/m, "")
          .trim();

        let output = `╔${"═".repeat(68)}╗\n`;
        output += `║ ${entry.title.padEnd(67)} ║\n`;
        output += `╚${"═".repeat(68)}╝\n\n`;
        output += `📁 分類：${entry.category}\n`;
        output += `📅 日期：${entry.createdAt}\n`;
        output += `🏷️ 標籤：${entry.tags.join(", ")}\n`;
        output += `📖 來源：${entry.source}\n`;
        output += `\n${"─".repeat(70)}\n\n`;
        output += mainContent + "\n\n";
        output += `${"─".repeat(70)}\n`;
        return output;
      },
    }),

    "lesson/list": tool({
      description: "列出所有經驗教訓",
      args: {
        severity: z.string().optional().describe("過濾嚴重等級"),
      },
      async execute(args) {
        const prov = p();
        const entries = await prov.listLessons(args.severity);

        if (entries.length === 0) return "📭 尚無教訓記錄";

        let output = "📚 教訓列表\n\n";
        const grouped = new Map<string, typeof entries>();
        for (const e of entries) {
          const list = grouped.get(e.severity) || [];
          list.push(e);
          grouped.set(e.severity, list);
        }

        for (const [sev, list] of grouped) {
          output += `## ${sev} (${list.length})\n`;
          for (const e of list) {
            output += `  - ${e.title} (${e.createdAt})\n`;
          }
          output += "\n";
        }
        return output;
      },
    }),

    "wiki/list": tool({
      description: "列出所有維基條目",
      args: {
        category: z.string().optional().describe("限定分類"),
        limit: z.number().optional().describe("限制數量"),
      },
      async execute(args) {
        const prov = p();
        const entries = await prov.listWiki(args.category, args.limit);

        if (entries.length === 0) return "📭 維基為空";

        let output = `📖 維基條目 (${entries.length} 筆)\n`;
        output += "═".repeat(70) + "\n";
        output += `${"標題".padEnd(25)} | ${"分類".padEnd(12)} | ${"日期".padEnd(10)}\n`;
        output += "─".repeat(70) + "\n";

        for (const e of entries) {
          const shortTitle =
            e.title.length > 23 ? e.title.slice(0, 23) + ".." : e.title;
          output += `${shortTitle.padEnd(25)} | ${e.category.slice(0, 10).padEnd(12)} | ${e.createdAt.padEnd(10)}\n`;
        }

        output += "═".repeat(70) + "\n";
        if (args.category) output += `\n📂 分類：${args.category}`;
        output += `\n💡 使用 wiki/read <標題> 閱讀完整內容`;
        return output;
      },
    }),

    "wiki/read": tool({
      description: "閱讀完整維基條目",
      args: {
        title: z.string().describe("維基標題（或部分標題）"),
        category: z.string().optional().describe("限定分類搜尋"),
      },
      async execute(args) {
        const prov = p();
        const entry = await prov.readWiki(args.title, args.category);

        if (!entry) return `📭 未找到維基：「${args.title}」`;

        const mainContent = entry.content
          .replace(/^> .+$/gm, "")
          .replace(/^---$/gm, "")
          .replace(/^## 元數據[\s\S]*$/m, "")
          .trim();

        let output = `╔${"═".repeat(68)}╗\n`;
        output += `║ 📖 ${entry.title.padEnd(64)} ║\n`;
        output += `╚${"═".repeat(68)}╝\n\n`;
        output += `📁 分類：${entry.category}\n`;
        output += `📅 日期：${entry.createdAt}\n`;
        output += `🏷️ 標籤：${entry.tags.join(", ")}\n`;
        output += `\n${"─".repeat(70)}\n\n`;
        output += mainContent + "\n\n";
        output += `${"─".repeat(70)}\n`;
        return output;
      },
    }),

    "knowledge/deduplicate": tool({
      description: "批量清除重複知識（基於語意相似度）",
      args: {
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.9)
          .describe("相似度閾值（預設 0.9）"),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe("預覽模式（不實際刪除）"),
      },
      async execute(args) {
        const prov = p();
        const { groups, removed } = await prov.deduplicate(
          args.threshold!,
          !args.dryRun,
        );

        if (groups.length === 0) return "✅ 未發現重複資料";

        let output = `🔍 發現 ${groups.length} 組重複資料\n\n`;
        for (const g of groups) {
          let keepTitle = basename(g.keep);
          try {
            const c = await readFile(g.keep, "utf8");
            keepTitle = c.match(/^# (.+)$/m)?.[1] || basename(g.keep);
          } catch {
            /* */
          }
          output += `📌 保留：${keepTitle}\n`;
          output += `   相似度：${(g.similarity * 100).toFixed(1)}%\n`;
          output += `   刪除：\n`;
          for (const rm of g.remove) {
            let rmTitle = basename(rm);
            try {
              const c = await readFile(rm, "utf8");
              rmTitle = c.match(/^# (.+)$/m)?.[1] || basename(rm);
            } catch {
              /* */
            }
            output += `     - ${rmTitle}\n`;
          }
          output += "\n";
        }

        if (!args.dryRun) {
          output += `\n✅ 已清除 ${removed} 筆重複資料`;
        } else {
          output += "\n💡 這是預覽模式，使用 dryRun=false 執行實際刪除";
        }
        return output;
      },
    }),
  };
}
