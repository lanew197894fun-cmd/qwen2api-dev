// Telegram Memory Bridge — tools.ts
// opencode 工具執行模組（bash/read/write/edit/glob/grep）
// 供 telegram bot 透過 /run 指令使用，讓模型能直接操作檔案系統

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { readdirSync } from "fs";
import { resolve } from "path";
import { ConversationStore, makeSessionId } from "./conversation-store";
import {
  KNOWLEDGE_TOOLS,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolName,
} from "./knowledge-tools";

// ── Tool types ──

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

// ── Tool execution ──

function execBash(cmd: string, timeoutMs = 30000): ToolResult {
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: out || "(completed, no output)" };
  } catch (e: any) {
    const msg = e.stdout || e.message || String(e);
    return { ok: false, output: msg.slice(0, 2000), error: e.message };
  }
}

function toolRead(fp: string): ToolResult {
  try {
    if (!existsSync(fp))
      return { ok: false, output: "", error: `not found: ${fp}` };
    const content = readFileSync(fp, "utf-8");
    return { ok: true, output: content.slice(0, 50000) };
  } catch (e: any) {
    return { ok: false, output: "", error: e.message };
  }
}

function toolWrite(fp: string, content: string): ToolResult {
  try {
    writeFileSync(fp, content, "utf-8");
    return { ok: true, output: `✓ written ${fp} (${content.length} bytes)` };
  } catch (e: any) {
    return { ok: false, output: "", error: e.message };
  }
}

function toolEdit(fp: string, oldStr: string, newStr: string): ToolResult {
  try {
    if (!existsSync(fp))
      return { ok: false, output: "", error: `not found: ${fp}` };
    let content = readFileSync(fp, "utf-8");
    if (!content.includes(oldStr)) {
      return { ok: false, output: "", error: `string not found in ${fp}` };
    }
    content = content.replace(oldStr, newStr);
    writeFileSync(fp, content, "utf-8");
    return { ok: true, output: `✓ edited ${fp} (1 replacement)` };
  } catch (e: any) {
    return { ok: false, output: "", error: e.message };
  }
}

function toolGlob(pattern: string, cwd: string): ToolResult {
  try {
    const g = new Bun.Glob(pattern);
    const results = [...g.scanSync({ cwd })];
    return { ok: true, output: results.join("\n") || "(no matches)" };
  } catch (e: any) {
    return { ok: false, output: "", error: e.message };
  }
}

function toolGrep(pattern: string, path: string, include?: string): ToolResult {
  try {
    const inc = include ? `--include="${include}"` : "";
    const cmd = `grep -rn ${inc} "${pattern}" "${path}" 2>/dev/null | head -100`;
    const out = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
    return { ok: true, output: out || "(no matches)" };
  } catch (e: any) {
    return { ok: false, output: "", error: e.message };
  }
}

// ── Conversation history context ──
// 讓模型在回答時自動查看近期對話歷史，提供上下文

export async function getRecentConversationContext(
  conv: ConversationStore,
  sessionId: string,
  maxMsgs = 20,
): Promise<string> {
  try {
    const msgs = await conv.getSession(sessionId);
    if (msgs.length === 0) return "";

    const recent = msgs.slice(-maxMsgs);
    const lines = recent.map((m) => {
      const role =
        m.role === "user" ? "👤" : m.role === "assistant" ? "🤖" : "⚙️";
      const content = (m.content || "").slice(0, 300);
      return `${role} ${content}`;
    });
    return [
      "📋 **近期對話上下文**",
      `（最近 ${recent.length} 則，共 ${msgs.length} 則）`,
      "",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

// ── Tool router ──

export type ToolName =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "glob"
  | "grep"
  | "history"
  | "skill"
  | KnowledgeToolName;

export interface ToolCall {
  name: ToolName;
  args: Record<string, string>;
}

export async function runTool(
  call: ToolCall,
  conv?: ConversationStore,
  sessionId?: string,
): Promise<ToolResult> {
  switch (call.name) {
    case "bash": {
      const cmd = call.args.command || call.args.cmd || "";
      if (!cmd) return { ok: false, output: "", error: "no command" };
      const timeout = parseInt(call.args.timeout || "30000", 10);
      return execBash(cmd, timeout);
    }
    case "read": {
      const fp = call.args.filePath || call.args.path || "";
      if (!fp) return { ok: false, output: "", error: "no filePath" };
      return toolRead(resolve(fp));
    }
    case "write": {
      const fp = call.args.filePath || call.args.path || "";
      const content = call.args.content || "";
      if (!fp) return { ok: false, output: "", error: "no filePath" };
      return toolWrite(resolve(fp), content);
    }
    case "edit": {
      const fp = call.args.filePath || call.args.path || "";
      const oldStr = call.args.oldString || "";
      const newStr = call.args.newString || "";
      if (!fp || !oldStr)
        return {
          ok: false,
          output: "",
          error: "filePath and oldString required",
        };
      return toolEdit(resolve(fp), oldStr, newStr);
    }
    case "glob": {
      const pattern = call.args.pattern || "";
      const cwd = call.args.path || call.args.dir || ".";
      if (!pattern) return { ok: false, output: "", error: "no pattern" };
      return toolGlob(pattern, resolve(cwd));
    }
    case "grep": {
      const pattern = call.args.pattern || call.args.query || "";
      const path = call.args.path || call.args.dir || ".";
      const include = call.args.include || "";
      if (!pattern) return { ok: false, output: "", error: "no pattern" };
      return toolGrep(pattern, resolve(path), include);
    }
    case "history": {
      if (!conv || !sessionId)
        return {
          ok: false,
          output: "",
          error: "conversation store not available",
        };
      const context = await getRecentConversationContext(conv, sessionId);
      return { ok: true, output: context || "(no conversation history)" };
    }
    case "skill": {
      const skillName = call.args.name || call.args.skill || "";
      if (!skillName)
        return { ok: false, output: "", error: "skill name required" };
      // 模擬技能調用：根據技能名稱執行對應邏輯
      // 目前支援：weather, summarize, search-decider (簡化版)
      if (skillName === "weather") {
        const loc = call.args.location || call.args.loc || "Taipei";
        try {
          const res = await fetch(
            `https://wttr.in/${encodeURIComponent(loc)}?format=j1`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok)
            return { ok: false, output: "", error: "weather API failed" };
          const data = (await res.json()) as any;
          const cur = data.current_condition?.[0];
          if (!cur) return { ok: false, output: "", error: "no weather data" };
          const output = [
            `🌤️ *${loc} 天氣*`,
            `溫度: ${cur.temp_C}°C (體感 ${cur.FeelsLikeC}°C)`,
            `狀況: ${cur.weatherDesc?.[0]?.value || "未知"}`,
            `濕度: ${cur.humidity}% | 風速: ${cur.windspeedKmph} km/h`,
          ].join("\n");
          return { ok: true, output };
        } catch (e) {
          return {
            ok: false,
            output: "",
            error: `weather fetch failed: ${(e as Error).message}`,
          };
        }
      }
      if (skillName === "summarize") {
        const url = call.args.url || "";
        if (!url)
          return { ok: false, output: "", error: "url required for summarize" };
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return { ok: false, output: "", error: "fetch failed" };
          const html = await res.text();
          // 簡單提取標題與前 500 字
          const titleMatch = html.match(/<title>(.*?)<\/title>/i);
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          const title = titleMatch ? titleMatch[1] : "Untitled";
          const body = bodyMatch
            ? bodyMatch[1].replace(/<[^>]+>/g, "").slice(0, 500)
            : "No content";
          return {
            ok: true,
            output: `📄 *${title}*\n\n${body}...`,
          };
        } catch (e) {
          return {
            ok: false,
            output: "",
            error: `summarize fetch failed: ${(e as Error).message}`,
          };
        }
      }
      return {
        ok: false,
        output: "",
        error: `unsupported skill: ${skillName} (supported: weather, summarize)`,
      };
    }
    default: {
      // 檢查是否為知識工具
      if (KNOWLEDGE_TOOL_NAMES.includes(call.name as KnowledgeToolName)) {
        const kt = KNOWLEDGE_TOOLS[call.name as KnowledgeToolName];
        if (kt) return await kt(call.args);
      }
      return { ok: false, output: "", error: `unknown tool: ${call.name}` };
    }
  }
}

// ── Parse natural language command into tool call ──

export function parseToolCommand(text: string): ToolCall | null {
  const trimmed = text.trim();

  // /run bash <command>
  const bashMatch = trimmed.match(/^\/run\s+bash\s+(.+)/s);
  if (bashMatch) return { name: "bash", args: { command: bashMatch[1] } };

  // /run read <path>
  const readMatch = trimmed.match(/^\/run\s+read\s+(.+)/);
  if (readMatch) return { name: "read", args: { filePath: readMatch[1] } };

  // /run write <path> | <content>
  const writeMatch = trimmed.match(/^\/run\s+write\s+(.+?)\s*\|\s*([\s\S]+)/);
  if (writeMatch)
    return {
      name: "write",
      args: { filePath: writeMatch[1], content: writeMatch[2] },
    };

  // /run edit <path> | <old> | <new>
  const editMatch = trimmed.match(
    /^\/run\s+edit\s+(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+)/,
  );
  if (editMatch)
    return {
      name: "edit",
      args: {
        filePath: editMatch[1],
        oldString: editMatch[2],
        newString: editMatch[3],
      },
    };

  // /run glob <pattern> [path]
  const globMatch = trimmed.match(/^\/run\s+glob\s+(\S+)(?:\s+(.+))?/);
  if (globMatch)
    return {
      name: "glob",
      args: { pattern: globMatch[1], path: globMatch[2] || "." },
    };

  // /run grep <pattern> [path]
  const grepMatch = trimmed.match(/^\/run\s+grep\s+(.+?)(?:\s+(.+))?$/);
  if (grepMatch)
    return {
      name: "grep",
      args: { pattern: grepMatch[1], path: grepMatch[2] || "." },
    };

  // /run history
  if (/^\/run\s+history/.test(trimmed)) return { name: "history", args: {} };

  // /run skill <name> [args]
  const skillMatch = trimmed.match(/^\/run\s+skill\s+(\S+)(?:\s+(.+))?$/);
  if (skillMatch) {
    const name = skillMatch[1];
    const argStr = skillMatch[2] || "";
    const args: Record<string, string> = { name };
    // 簡單解析 key=value 參數
    argStr.split(/\s+/).forEach((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        args[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
      }
    });
    return { name: "skill", args };
  }

  // /run knowledge_save title=<title> content=<content> [category=<cat>] [tags=<a,b,c>] [source=<src>]
  const ksMatch = trimmed.match(
    /^\/run\s+knowledge_save\s+title=(.+?)\s+content=(.+?)(?:\s+\w+=.+)?$/s,
  );
  if (trimmed.startsWith("/run knowledge_save ")) {
    const args = parseKeyValue(trimmed.slice("/run knowledge_save ".length));
    if (args.title && args.content) return { name: "knowledge_save", args };
  }
  // /run knowledge_read title=<title> [category=<cat>]
  if (trimmed.startsWith("/run knowledge_read ")) {
    const args = parseKeyValue(trimmed.slice("/run knowledge_read ".length));
    if (args.title) return { name: "knowledge_read", args };
  }
  // /run knowledge_index [category=<cat>] [limit=<n>]
  if (trimmed.startsWith("/run knowledge_index")) {
    const argStr = trimmed.slice("/run knowledge_index".length).trim();
    return { name: "knowledge_index", args: parseKeyValue(argStr) };
  }
  // /run knowledge_deduplicate [threshold=<0-1>] [dryRun=<true|false>]
  if (trimmed.startsWith("/run knowledge_deduplicate")) {
    const argStr = trimmed.slice("/run knowledge_deduplicate".length).trim();
    return { name: "knowledge_deduplicate", args: parseKeyValue(argStr) };
  }
  // /run lesson_save title=<title> scenario=<s> mistake=<m> [solution=<s>] [severity=<P0-P4>]
  if (trimmed.startsWith("/run lesson_save ")) {
    const args = parseKeyValue(trimmed.slice("/run lesson_save ".length));
    if (args.title && args.scenario && args.mistake)
      return { name: "lesson_save", args };
  }
  // /run lesson_list [severity=<P0-P4>]
  if (trimmed.startsWith("/run lesson_list")) {
    const argStr = trimmed.slice("/run lesson_list".length).trim();
    return { name: "lesson_list", args: parseKeyValue(argStr) };
  }
  // /run wiki_save title=<title> content=<content> [category=<cat>] [tags=<a,b,c>]
  if (trimmed.startsWith("/run wiki_save ")) {
    const args = parseKeyValue(trimmed.slice("/run wiki_save ".length));
    if (args.title && args.content) return { name: "wiki_save", args };
  }
  // /run wiki_list [category=<cat>] [limit=<n>]
  if (trimmed.startsWith("/run wiki_list")) {
    const argStr = trimmed.slice("/run wiki_list".length).trim();
    return { name: "wiki_list", args: parseKeyValue(argStr) };
  }
  // /run wiki_read title=<title> [category=<cat>]
  if (trimmed.startsWith("/run wiki_read ")) {
    const args = parseKeyValue(trimmed.slice("/run wiki_read ".length));
    if (args.title) return { name: "wiki_read", args };
  }

  return null;
}

// 簡單 key=value 解析器（支援 quoted value）
function parseKeyValue(text: string): Record<string, string> {
  const args: Record<string, string> = {};
  // 匹配 key=value，value 可為 quoted 或 bare
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    args[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return args;
}
