/**
 * index.js — qwen2api-plugin 插件入口
 *
 * 註冊 17 個工具供 opencode 使用，所有工具委派至 chat-proxy (port 3456) 執行。
 * 2026-07-12: 從測試碼還原為完整工具註冊（原碼被覆寫）
 */

import http from "node:http";
import { startProxy, PROXY_PORT } from "./chat-proxy.js";

const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

// 2026-11-05 Fix：插件工具原本不帶 Authorization，proxy 一律回 401
// → 所有 qwen_* 工具（含 wiki/memory/skill/grep）全失效，模型只能回「未找到」。
const AUTH_HEADERS = {
  Authorization: `Bearer ${process.env.QWEN2API_KEY || process.env.API_KEY || "sk-qwen2api-test-2026"}`,
};

/** 統一解析 proxy 回應：{content:"..."} → 字串；其他 → JSON 字串 */
const unwrap = (obj, raw) => {
  if (obj && typeof obj.content === "string") return obj.content;
  if (obj && obj.error) return `❌ ${obj.error.message || JSON.stringify(obj.error)}`;
  return raw;
};

// ─── HTTP 呼叫輔助 ───
const _post = (path, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${PROXY_URL}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...AUTH_HEADERS,
        },
        timeout: 65000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(unwrap(JSON.parse(buf), buf));
          } catch {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });

const _get = (path) =>
  new Promise((resolve, reject) => {
    http
      .get(
        `${PROXY_URL}${path}`,
        { timeout: 10000, headers: AUTH_HEADERS },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try {
              resolve(unwrap(JSON.parse(buf), buf));
            } catch {
              resolve(buf);
            }
          });
        },
      )
      .on("error", reject);
  });

// ─── 工具定義 ───
const TOOLS = [
  {
    name: "read",
    description: "讀取檔案內容",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "檔案路徑" },
        offset: { type: "number", description: "起始行號（1-indexed）" },
        limit: { type: "number", description: "最大行數" },
      },
      required: ["filePath"],
    },
    execute: (args) => _post("/tool/read", args),
  },
  {
    name: "write",
    description: "寫入或建立檔案",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "檔案路徑" },
        content: { type: "string", description: "檔案內容" },
      },
      required: ["filePath", "content"],
    },
    execute: (args) => _post("/tool/write", args),
  },
  {
    name: "edit",
    description: "編輯檔案（尋找取代）",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "檔案路徑" },
        oldString: { type: "string", description: "要尋找的文字" },
        newString: { type: "string", description: "取代為的文字" },
      },
      required: ["filePath", "oldString", "newString"],
    },
    execute: (args) => _post("/tool/edit", args),
  },
  {
    name: "glob",
    description: "搜尋檔案（通配符）",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式" },
        path: { type: "string", description: "搜尋目錄" },
      },
      required: ["pattern"],
    },
    execute: (args) => _post("/tool/glob", args),
  },
  {
    name: "grep",
    description: "檔案內容正則搜尋",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正規表達式" },
        path: { type: "string", description: "搜尋目錄" },
        include: { type: "string", description: "檔案過濾 pattern" },
      },
      required: ["pattern"],
    },
    execute: (args) => _post("/tool/grep", args),
  },
  {
    name: "bash",
    description: "執行 shell 命令",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要執行的命令" },
        cwd: { type: "string", description: "工作目錄" },
        timeout: { type: "number", description: "逾時毫秒" },
      },
      required: ["command"],
    },
    execute: (args) => _post("/tool/bash", args),
  },
  {
    name: "skill_list",
    description: "列出所有可用技能",
    parameters: { type: "object", properties: {} },
    execute: () => _post("/tool/skill-list", {}),
  },
  {
    name: "skill_read",
    description: "讀取指定技能內容",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名稱" },
      },
      required: ["name"],
    },
    execute: (args) => _post("/tool/skill-read", args),
  },
  {
    name: "wiki_search",
    description: "搜尋知識庫/維基",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字" },
      },
      required: ["query"],
    },
    execute: (args) => _post("/tool/wiki-search", args),
  },
  {
    name: "wiki_read",
    description: "讀取維基頁面",
    parameters: {
      type: "object",
      properties: {
        page: { type: "string", description: "頁面名稱或路徑" },
      },
      required: ["page"],
    },
    execute: (args) => _post("/tool/wiki-read", args),
  },
  {
    name: "memory",
    description: "查詢記憶系統",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字" },
      },
      required: ["query"],
    },
    execute: (args) => _post("/tool/memory-query", args),
  },
  {
    name: "health",
    description: "服務健康狀態",
    parameters: { type: "object", properties: {} },
    execute: () => _get("/health"),
  },
  {
    name: "repair",
    description: "自我修復（依賴檢查/目錄建立/GC）",
    parameters: { type: "object", properties: {} },
    execute: () => _post("/health/repair", {}),
  },
  {
    name: "token",
    description: "Token 狀態檢查與更新指引",
    parameters: { type: "object", properties: {} },
    execute: () => _get("/health"),
  },
  {
    name: "diagnose",
    description: "完整診斷（建議優先使用）",
    parameters: { type: "object", properties: {} },
    execute: () => _post("/repair/diagnose", {}),
  },
  {
    name: "proxy_status",
    description: "Chat Proxy 狀態（模式/路由/降級）",
    parameters: { type: "object", properties: {} },
    execute: () => _get("/health"),
  },
  {
    name: "repair_manual",
    description: "維修手冊查詢",
    parameters: { type: "object", properties: {} },
    execute: () => _get("/repair/manual"),
  },
];

// ─── 插件入口（opencode 會 import 此檔案） ───
export default function plugin() {
  // 背景啟動 proxy（不阻塞插件載入）
  startProxy().catch((e) => {
    console.error(`[qwen2api-plugin] Proxy 啟動失敗: ${e.message}`);
  });

  return {
    name: "qwen2api",
    version: "1.0.0",
    tools: TOOLS,
  };
}

export { TOOLS, startProxy };
