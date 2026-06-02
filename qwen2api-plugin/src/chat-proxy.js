/**
 * chat-proxy.js — Qwen2API Chat Proxy with standard OpenAI function calling
 *
 * 功能：
 * • 接受 /v1/chat/completions 請求
 * • 當請求含 tools 時，利用 qwen2api native tool support（tool-prompt.js）
 * • qwen2api 將 tools 轉為 <tool_call> XML 送 Qwen API，再解析回 tool_calls
 * • Proxy 執行 tool_calls（read/write/edit/glob/grep/bash），結果送回繼續
 * • 若模型無 tool_calls 但有 bash 區塊，自動執行並送回（fallback）
 * • 完全相容 OpenAI 格式（stream / non-stream）
 * • 非聊天端點自動轉發到 qwen2api
 *
 * 雙層機制：
 *   1. tool_calls（標準）— qwen2api 原生解析 <tool_call> XML
 *   2. bash fallback — 當模型偏好輸出 bash 區塊時直接執行
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { detectHardware, getHardwareInfo } from "./hardware-detect.js";
import { getPath, execShell, execGrep } from "./platform.js";

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LV = (() => {
  const raw = process.env.PROXY_LOG_LEVEL;
  if (raw && LOG_LEVELS[raw] !== undefined) return LOG_LEVELS[raw];
  if (process.env.PROXY_QUIET === "true" || process.env.PROXY_QUIET === "1")
    return 0;
  return 3; // 預設 info — 顯示啟動資訊與一般狀態
})();
const log = {
  debug: (...a) => {
    if (LV >= 4) console.log("[proxy]", ...a);
  },
  info: (...a) => {
    if (LV >= 3) console.log("[proxy]", ...a);
  },
  warn: (...a) => {
    if (LV >= 2) console.warn("[proxy]", ...a);
  },
  error: (...a) => {
    if (LV >= 1) console.error("[proxy]", ...a);
  },
};

process.on("unhandledRejection", (e) => {
  log.error("💥 未捕捉 rejection:", e?.message || e);
});
process.on("uncaughtException", (e) => {
  try {
    log.error("💥 未捕捉 exception:", e?.message || e);
  } catch {
    console.error("[proxy] FATAL:", e?.message || e);
  }
});

const QWEN2API_PORT = parseInt(process.env.QWEN2API_PORT || "3000", 10);
const QWEN2API_HOST = process.env.QWEN2API_HOST || "127.0.0.1";
const _QWEN2API_HOST = QWEN2API_HOST.includes(":")
  ? `[${QWEN2API_HOST}]`
  : QWEN2API_HOST;
const QWEN2API_URL = `http://${_QWEN2API_HOST}:${QWEN2API_PORT}`;
const MEMORY_BRIDGE_URL =
  process.env.MEMORY_BRIDGE_URL || "http://localhost:4377";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3456");
const API_KEY = process.env.API_KEY || "CHANGE_ME";
const MAX_LOOPS = 5;
const MAX_BODY = parseInt(process.env.PROXY_MAX_BODY || "1048576", 10); // 請求 body 上限預設 1MB (可透過 PROXY_MAX_BODY 調整)
const PROJ_DIR = getPath("projectDir");

// ─── 可配置 timeout 常數（可透過環境變數覆蓋） ───
const CFG_TIMEOUT = {
  chat: parseInt(process.env.PROXY_CHAT_TIMEOUT || "300000", 10), // 一般聊天 5min (降低無回應風險)
  thinking: parseInt(process.env.PROXY_THINKING_TIMEOUT || "600000", 10), // thinking 模式 10min
  health: parseInt(process.env.PROXY_HEALTH_TIMEOUT || "10000", 10), // 健康檢查 10s
  retries: parseInt(process.env.PROXY_RETRIES || "2", 10), // 重試次數
};

// ─── ConversationMemory：對話記憶與摘要（預設關閉） ───
// 啟用: PROXY_CONV_MEMORY=true
// 功能：滑動窗口壓縮、閒聊過濾、跨 session 摘要持久化
const CONV_MEMORY_ENABLED = process.env.PROXY_CONV_MEMORY !== "false"; // 預設開啟，設 false 關閉
const CONV_SUMMARY_INTERVAL = parseInt(
  process.env.PROXY_SUMMARY_INTERVAL || "5",
  10,
);
const CONV_RECENT_MSGS = parseInt(process.env.PROXY_RECENT_MSGS || "15", 10);
const CONV_MAX_HISTORY_TOKENS = parseInt(
  process.env.PROXY_MAX_HISTORY_TOKENS || "8000",
  10,
);
// 跨平台家目錄：Windows 用 USERPROFILE，其餘用 HOME
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || "~";
const CONV_MEMORY_FILE = path.join(
  HOME_DIR,
  ".opencode",
  "conversation-memory.json",
);
const CONV_SESSION_ID = process.env.PROXY_SESSION_ID || "default";

// 對話記憶儲存體（in-memory + 持久化）
let convSummary = "";
let convExchangeCount = 0;

// 載入已存在的記憶
try {
  if (CONV_MEMORY_ENABLED) {
    const memRaw = fs.readFileSync(CONV_MEMORY_FILE, "utf-8");
    const mem = JSON.parse(memRaw);
    convSummary = mem[CONV_SESSION_ID]?.summary || "";
    convExchangeCount = mem[CONV_SESSION_ID]?.exchangeCount || 0;
    if (convSummary) log.info(`🧠 載入對話記憶 (${convSummary.length}ch)`);
  }
} catch {
  /* 首次使用，尚無記憶檔案 */
}

// 持久化記憶
const persistMemory = () => {
  if (!CONV_MEMORY_ENABLED) return;
  try {
    const dir = path.dirname(CONV_MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let mem = {};
    try {
      mem = JSON.parse(fs.readFileSync(CONV_MEMORY_FILE, "utf-8"));
    } catch {
      /* 新檔案 */
    }
    mem[CONV_SESSION_ID] = {
      summary: convSummary,
      exchangeCount: convExchangeCount,
      updated: new Date().toISOString(),
    };
    fs.writeFileSync(CONV_MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
  } catch (e) {
    log.error("❌ 持久化記憶失敗:", e.message);
  }
};

// ─── 對話歷史儲存（JSONL 格式，與 bridge 一致） ───
// 啟用: PROXY_CONV_HISTORY=true
// 儲存位置: ~/.opencode/conversations/raw/YYYY-MM/<sessionId>.jsonl
// 索引: ~/.opencode/conversations/index.json
const CONV_HISTORY = process.env.PROXY_CONV_HISTORY !== "false";
const CONV_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "~",
  ".opencode/conversations",
);
const CONV_SRC = process.env.PROXY_CONV_SOURCE || "proxy";

// 摘要里程碑（與 TS 端一致）
const SUMMARY_INTERVAL = 50;
const SUMMARY_MIN_MSGS = 10;

const convDir = CONV_DIR;
const convIdx = {};

const convInit = () => {
  if (!CONV_HISTORY) return;
  try {
    const idxf = path.join(convDir, "index.json");
    if (fs.existsSync(idxf))
      Object.assign(convIdx, JSON.parse(fs.readFileSync(idxf, "utf-8")));
  } catch {}
  fs.mkdirSync(path.join(convDir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(convDir, "sessions"), { recursive: true });
};

// 讀取現有 index → 合併 → 寫回（避免覆蓋其他來源的 session）
const convMergeIdx = (sid, entry) => {
  try {
    const idxf = path.join(convDir, "index.json");
    let idx = {};
    try {
      if (fs.existsSync(idxf)) idx = JSON.parse(fs.readFileSync(idxf, "utf-8"));
    } catch {}
    // 合併既有資料
    idx[sid] = entry;
    fs.writeFileSync(idxf, JSON.stringify(idx, null, 2), "utf-8");
  } catch (e) {
    log.error("❌ convMergeIdx 失敗:", e.message);
  }
};

const convSessionId = () => {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const suffix = process.env.PROXY_CONV_SESSION || "opencode";
  return `${day}-${CONV_SRC}-${suffix}`;
};

const convRecord = (role, content, model) => {
  if (!CONV_HISTORY) return;
  if (!content || typeof content !== "string") return;
  // 過濾閒聊（user 端的純招呼、表情、單字回覆不記錄）
  if (role === "user" && isCasual({ content })) return;
  const sid = convSessionId();
  const ts = new Date().toISOString();
  const line =
    JSON.stringify({ role, content, ts, source: CONV_SRC, model }) + "\n";
  const month = ts.slice(0, 7);
  const rawDir = path.join(convDir, "raw", month);
  try {
    fs.mkdirSync(rawDir, { recursive: true });
    fs.appendFileSync(path.join(rawDir, `${sid}.jsonl`), line, "utf-8");
    // 每次寫入前重新讀取 index，避免覆蓋其他來源
    convMergeIdx(sid, {
      id: sid,
      date: ts.slice(0, 10),
      source: CONV_SRC,
      msgCount: (convIdx[sid]?.msgCount || 0) + 1,
      firstTs: convIdx[sid]?.firstTs || ts,
      lastTs: ts,
      tags: [],
    });
    // 更新記憶體 cache
    if (convIdx[sid]) {
      convIdx[sid].msgCount++;
      convIdx[sid].lastTs = ts;
    } else {
      convIdx[sid] = {
        id: sid,
        date: ts.slice(0, 10),
        source: CONV_SRC,
        msgCount: 1,
        firstTs: ts,
        lastTs: ts,
        tags: [],
      };
    }

    // 自動摘要：達到里程碑時觸發
    const nxt = convIdx[sid].msgCount;
    if (
      nxt >= SUMMARY_MIN_MSGS &&
      (nxt % SUMMARY_INTERVAL === 0 || nxt === SUMMARY_MIN_MSGS)
    ) {
      convTriggerSummary(sid);
    }
  } catch (e) {
    log.error("❌ convRecord 寫入失敗:", e.message);
  }
};

// 摘要 backoff（避免 429 風暴）
const summaryBackoff = new Map();
const SUMMARY_BACKOFF_MS = 120_000; // 429/錯誤後冷卻 2 分鐘

// 觸發 AI 摘要（呼叫 bridge API）
const convTriggerSummary = (sid) => {
  if (!MEMORY_BRIDGE_URL) return;
  // 檢查 cooldown
  const until = summaryBackoff.get(sid);
  if (until && Date.now() < until) return;
  // 非同步執行，不 blocking
  fetch(
    `${MEMORY_BRIDGE_URL}/api/conversations/${encodeURIComponent(sid)}?summarize=1`,
    {
      method: "GET",
      signal: AbortSignal.timeout(60000),
    },
  )
    .then((res) => {
      if (res.ok) {
        summaryBackoff.delete(sid);
        log.info(`📝 自動摘要完成: ${sid}`);
      } else {
        summaryBackoff.set(sid, Date.now() + SUMMARY_BACKOFF_MS);
        log.warn(`⚠️ 自動摘要回傳 ${res.status}: ${sid}（冷卻 2 分鐘）`);
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        summaryBackoff.set(sid, Date.now() + SUMMARY_BACKOFF_MS);
        log.error(`❌ 自動摘要請求失敗: ${err.message}（冷卻 2 分鐘）`);
      }
    });
};

// 初始化
convInit();

// 閒聊偵測：純招呼、表情、單字回覆
const isCasual = (msg) => {
  if (!msg?.content || typeof msg.content !== "string") return false;
  const c = msg.content.trim();
  // 長內容不可能是閒聊
  if (c.length > 50) return false;
  // 純表情/標點
  if (/^[\p{Emoji}\s.,!?~。，！？～]+$/u.test(c)) return true;
  // 純招呼用語
  const casualPatterns =
    /^(hi|hello|hey|ok|okay|thanks|thank you|thx|好的|好|嗯|了解|明白|知道了|👍|👌|yes|no|yep|nope|sure|great|nice|bye|goodbye|晚安|早安|哈囉|嗨|謝謝|謝[了啦]?)$/i;
  if (casualPatterns.test(c)) return true;
  return false;
};

// 從訊息中萃取關鍵資訊供摘要用
const extractKeyInfo = (msgs) => {
  const info = {
    files: [],
    commands: [],
    errors: [],
    decisions: [],
    prefs: [],
  };
  for (const m of msgs) {
    const c = typeof m.content === "string" ? m.content : "";
    // 檔案操作
    const files = c.match(
      /(?:modified|created|deleted|edited|read|write|fix|fixed|change|update|updated)\s+(?:file\s+)?([^\s,;：。]+\.\w+)/gi,
    );
    if (files)
      info.files.push(
        ...files.map((f) =>
          f.replace(
            /^(modified|created|deleted|edited|read|write|fix|fixed|change|update|updated)\s+(?:file\s+)?/i,
            "",
          ),
        ),
      );
    // 錯誤訊息
    if (c.match(/error|fail|exception|crash|bug|broken|❌|💥/i))
      info.errors.push(c.slice(0, 200));
    // 命令
    const cmds = c.match(/(?:executed|ran|run|running)\s+`([^`]+)`/gi);
    if (cmds) info.commands.push(...cmds);
    // 用戶偏好（用戶說喜歡/想要/常用的東西）
    const prefs = c.match(
      /(?:我(?:喜歡|偏好|常用|想要|希望)|用|使用|選)\s*([^，。；!？]{2,30})/gi,
    );
    if (prefs) info.prefs.push(...prefs);
    // 決策或選擇
    const decisions = c.match(
      /(?:決定|選擇|採用|換成|改用|就用)\s*([^，。；!？]{2,30})/gi,
    );
    if (decisions) info.decisions.push(...decisions);
  }
  // 去重
  info.files = [...new Set(info.files)];
  info.commands = [...new Set(info.commands)];
  info.errors = [...new Set(info.errors)];
  info.decisions = [...new Set(info.decisions)];
  info.prefs = [...new Set(info.prefs)];
  return info;
};

// 建構摘要字串
const buildSummary = (info) => {
  const parts = [];
  if (info.files.length > 0)
    parts.push(
      `📄 檔案: ${info.files.slice(0, 5).join(", ")}${info.files.length > 5 ? ` +${info.files.length - 5}` : ""}`,
    );
  if (info.commands.length > 0)
    parts.push(`⚡ 命令: ${info.commands.slice(0, 3).join(", ")}`);
  if (info.errors.length > 0) parts.push(`❌ 錯誤: ${info.errors.length} 次`);
  if (info.decisions.length > 0)
    parts.push(`💡 決策: ${info.decisions.slice(0, 3).join(", ")}`);
  if (info.prefs.length > 0)
    parts.push(`⭐ 偏好: ${info.prefs.slice(0, 3).join(", ")}`);
  return parts.join(" | ");
};

// 處理訊息：過濾閒聊 + 注入摘要
const processWithMemory = (messages) => {
  if (!CONV_MEMORY_ENABLED || !messages?.length) return messages;

  convExchangeCount++;

  // 過濾閒聊（從歷史中移除，保留最後一條因為可能是本次請求）
  const filtered = messages.filter(
    (m, i) => i === messages.length - 1 || !isCasual(m),
  );
  const filteredOut = messages.length - filtered.length;
  if (filteredOut > 0) log.debug(`🧹 過濾 ${filteredOut} 條閒聊訊息`);

  // 估算 token 數
  const totalChars = filtered.reduce(
    (s, m) => s + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  const totalTokens = Math.ceil(totalChars / 4);

  // 若超過 threshold，觸發壓縮
  if (
    totalTokens > CONV_MAX_HISTORY_TOKENS &&
    convExchangeCount % CONV_SUMMARY_INTERVAL === 0
  ) {
    // 保留最近 N 條，前面的用摘要取代
    const recent = filtered.slice(-CONV_RECENT_MSGS);
    const older = filtered.slice(0, -CONV_RECENT_MSGS);

    // 萃取關鍵資訊更新摘要
    const keyInfo = extractKeyInfo(older);
    const newSummary = buildSummary(keyInfo);
    if (newSummary) {
      // 合併舊摘要與新資訊
      const existing = convSummary ? convSummary + " | " : "";
      convSummary = existing + newSummary;
      // 限制摘要長度
      if (convSummary.length > 3000) convSummary = convSummary.slice(-3000);
      persistMemory();
      log.info(`📝 對話摘要已更新 (${convSummary.length}ch)`);
    }

    // 注入摘要 + 保留最近訊息
    const summaryMsg = convSummary
      ? { role: "system", content: `[對話摘要]\n${convSummary}` }
      : null;
    return summaryMsg ? [summaryMsg, ...recent] : recent;
  }

  return filtered;
};

// ─── Rate Limiter（滑動窗口，無依賴） ───
const RL_MAX = parseInt(process.env.PROXY_RATE_LIMIT || "600"); // 本機環境放寬至 600 req/min
const RL_WIN = parseInt(process.env.PROXY_RATE_WINDOW || "60000");
const rlBuckets = new Map();

function checkRL(ip) {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + RL_WIN };
    rlBuckets.set(ip, b);
  }
  b.count++;
  // 每分鐘清理過期條目
  if (rlBuckets.size > 10000) {
    const cutoff = Date.now();
    for (const [k, v] of rlBuckets) {
      if (cutoff > v.reset) rlBuckets.delete(k);
    }
  }
  return b.count <= RL_MAX;
}

// ─── 環境自動偵測與模型路由 ───
//
// 啟動時自動查詢 qwen2api 可用模型，按能力分級：
//   small  — 輕量模型（27B 以下），適合簡單任務
//   medium — 平衡模型（預設），適合一般任務
//   large  — 強模型（235B+），適合複雜任務
//
// 可透過環境變數覆蓋：
//   PROXY_SMALL_MODEL=xxx    — 強制指定小模型
//   PROXY_MEDIUM_MODEL=xxx   — 強制指定中模型
//   PROXY_LARGE_MODEL=xxx    — 強制指定大模型
//   PROXY_ROUTE=off          — 停用自動路由

const COMPLEX_KEYWORDS = [
  "fix",
  "repair",
  "debug",
  "implement",
  "create",
  "build",
  "deploy",
  "refactor",
  "optimize",
  "analyze",
  "investigate",
  "troubleshoot",
  "修復",
  "除錯",
  "實作",
  "建立",
  "部署",
  "重構",
  "優化",
  "分析",
];

// 從模型名稱推斷能力等級
const classifyModel = (name) => {
  const n = (name || "").toLowerCase();
  // 大型模型：235B, Max, Preview
  if (n.includes("235b") || n.includes("max") || n.includes("preview"))
    return "large";
  // 中型模型：Plus, 72B 以上但非 Max
  if (n.includes("plus") || n.includes("coder")) return "medium";
  // 小型模型：27B, Flash, 輕量
  if (n.includes("27b") || n.includes("flash") || n.includes("35b"))
    return "small";
  // 預設為 medium
  return "medium";
};

// 從 qwen2api 取得可用模型並分級
let envModels = null;
let envDetected = false;

// 判斷模型 ID 是否為 -coder 字尾變體（不匹配 Qwen3-Coder 這種獨立命名）
const isCoderVariant = (id) => {
  const n = String(id || "");
  // 獨立 Qwen3-Coder 模型正常運作，不應被過濾或重新導向
  if (n.toLowerCase() === "qwen3-coder") return false;
  return (
    n.endsWith("-coder") ||
    n.endsWith("-thinking-coder") ||
    n.endsWith("-search-coder") ||
    n.endsWith("-thinking-search-coder")
  );
};

const detectEnv = async () => {
  if (envDetected) return;
  envDetected = true;
  try {
    const models = await getJSON(`${QWEN2API_URL}/v1/models`);
    let list = models?.data || models || [];
    if (!Array.isArray(list)) list = [];
    const byLevel = { small: [], medium: [], large: [] };
    for (const m of list) {
      const id = m.id || m.name || "";
      // 過濾 -coder 字尾變體（上游回傳空內容），避免自動路由選到
      if (isCoderVariant(id)) continue;
      const level = classifyModel(id);
      if (!byLevel[level].includes(id)) byLevel[level].push(id);
    }
    envModels = byLevel;
    log.info(`🌍 環境偵測: ${list.length} 模型可用`);
    if (LV >= 4) {
      for (const lvl of ["small", "medium", "large"]) {
        if (envModels[lvl].length > 0)
          log.debug(`  ${lvl}: ${envModels[lvl].join(", ")}`);
      }
    }
  } catch (e) {
    log.info(`模型偵測略過: ${e.message}，使用預設路由`);
    envModels = null;
  }
};

const getModelForLevel = (level) => {
  // 環境變數強制指定優先
  const envKey = `PROXY_${level.toUpperCase()}_MODEL`;
  if (process.env[envKey]) return process.env[envKey];

  // 從偵測到的模型列表選擇
  if (envModels?.[level]?.length > 0) return envModels[level][0];

  // 硬編碼預設值
  const defaults = {
    small: "qwen3.6-27b",
    medium: "qwen3.6-plus",
    large: "qwen3-235b-a22b",
  };
  return defaults[level] || defaults.medium;
};

// ─── 任務複雜度分析 ───

const analyzeComplexity = (body) => {
  const { messages, tools, tool_choice } = body;
  let score = 0;

  const text = (messages || [])
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
  const len = text.length;

  if (len > 2000) score += 3;
  else if (len > 800) score += 2;
  else if (len > 200) score += 1;

  const nTools = tools?.length || 0;
  // 有工具請求即視為至少中等複雜度
  if (nTools > 0) score += 2;
  if (nTools > 5) score += 1;
  if (nTools > 10) score += 1;

  if (tool_choice === "required") score += 2;

  const lower = text.toLowerCase();
  for (const kw of COMPLEX_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      score += 1;
      break;
    }
  }

  if (score >= 5) return "large";
  if (score >= 2) return "medium";
  return "small";
};

const waitForBackend = async (portBusy) => {
  if (portBusy) {
    // 已有進程但未就緒 → 等待最多 6 秒（systemd Restart=always 會自動恢復）
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isUp()) return "recovered";
    }
    return "port_occupied";
  }
};

const routeModel = (body) => {
  if (process.env.PROXY_ROUTE === "off")
    return body.model || getModelForLevel("medium");

  // ─── 使用者明確指定 -coder 變體 → 導向獨立 Qwen3-Coder ───
  // -coder 字尾變體（Qwen3.6-Plus-coder 等）上游回傳空內容，
  // 不應只用複雜度路由，而應保留 coder 意圖導向獨立運作的 coder 模型。
  const orig = body.model || "";
  if (orig && isCoderVariant(orig)) {
    // 從所有等級中尋找獨立 Qwen3-Coder（排除 -coder 字尾變體但保留獨立 coder 模型）
    const pools = ["small", "medium", "large"];
    for (const lvl of pools) {
      const match = (envModels?.[lvl] || []).find(
        (m) =>
          m.toLowerCase() === "qwen3-coder" ||
          m.toLowerCase() === "qwen3-coder-plus",
      );
      if (match) {
        log.info(`📡 coder (${orig} → ${match})`);
        return match;
      }
    }
    // 環境偵測未完成或找不到時，用 env var 或硬編碼預設
    const coderDefault = process.env.PROXY_CODER_MODEL || "qwen3-coder-plus";
    log.info(`📡 coder (${orig} → ${coderDefault})`);
    return coderDefault;
  }

  let level = analyzeComplexity(body);
  // 硬體感知：若硬體不足，降級模型等級
  const hw = detectHardware();
  const hwOrder = { small: 0, medium: 1, large: 2 };
  const taskOrder = hwOrder[level] ?? 1;
  const hwLimit = hwOrder[hw.level] ?? 1;
  if (taskOrder > hwLimit) {
    const downgraded =
      Object.entries(hwOrder).find(([, v]) => v <= hwLimit)?.[0] || "medium";
    log.info(`📡 ${level}→${downgraded} (硬體受限: ${hw.reason})`);
    level = downgraded;
  }
  let model = getModelForLevel(level);
  // 保留 thinking 後綴：若原始模型含 -thinking，路由後的模型也加上
  if (model !== orig && orig.toLowerCase().includes("thinking")) {
    const base = model.replace(/-thinking$/i, "");
    model = `${base}-thinking`;
  }
  if (model !== orig && orig) {
    log.debug(`📡 ${level} (${orig} → ${model})`);
  }
  return model;
};

// ─── HTTP helpers (Bun.fetch) ───

const authHeaders = {
  Authorization: `Bearer ${API_KEY}`,
};

/** 帶重試的延遲 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * postJSON — 帶可配置超時與重試
 * @param {string} url
 * @param {object} body
 * @param {number} timeout  — 單次請求超時 (ms)，預設 60s
 * @param {number} retries  — 重試次數，預設 2（最多 3 次嘗試）
 */
const postJSON = async (url, body, timeout = 60000, retries = 2) => {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const txt = await res.text();
      try {
        return JSON.parse(txt);
      } catch {
        return { content: txt };
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isTimeout = e.name === "AbortError";
      if (attempt < retries) {
        const wait = Math.min(1000 * 2 ** attempt, 5000);
        log.info(
          `📤 postJSON 重試 ${attempt + 1}/${retries} (${isTimeout ? "timeout" : e.message})，等待 ${wait}ms...`,
        );
        await delay(wait);
        continue;
      }
      if (isTimeout) throw new Error("timeout");
      throw e;
    }
  }
  throw lastErr;
};

/**
 * getJSON — 帶可配置超時與重試
 * @param {string} url
 * @param {number} timeout  — 單次請求超時 (ms)，預設 15s
 * @param {number} retries  — 重試次數，預設 2（最多 3 次嘗試）
 */
const getJSON = async (url, timeout = 15000, retries = 2) => {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: authHeaders,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const txt = await res.text();
      try {
        return JSON.parse(txt);
      } catch {
        return null;
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isTimeout = e.name === "AbortError";
      if (attempt < retries) {
        const wait = Math.min(1000 * 2 ** attempt, 5000);
        log.info(
          `📤 getJSON 重試 ${attempt + 1}/${retries} (${isTimeout ? "timeout" : e.message})，等待 ${wait}ms...`,
        );
        await delay(wait);
        continue;
      }
      if (isTimeout) throw new Error("timeout");
      throw e;
    }
  }
  throw lastErr;
};

// ─── MCP call via qwen2api ───

// ─── 本地工具執行（替代 MCP 端點） ───
// Qwen2API 沒有 MCP 端點，直接在 proxy 內建執行工具

const execTool = async (name, args) => {
  switch (name) {
    case "read": {
      const fp = args.filePath || args.path;
      if (!fp) return "";
      try {
        return await Bun.file(fp).text();
      } catch {
        try {
          return fs.readFileSync(fp, "utf-8");
        } catch (e) {
          return `[無法讀取 ${fp}: ${e.message}]`;
        }
      }
    }
    case "write": {
      const fp = args.filePath || args.path;
      const content = args.content || "";
      if (!fp) return "";
      try {
        await Bun.write(fp, content);
        return `✓ 已寫入 ${fp}`;
      } catch {
        try {
          fs.writeFileSync(fp, content, "utf-8");
          return `✓ 已寫入 ${fp}`;
        } catch (e) {
          return `[寫入失敗 ${fp}: ${e.message}]`;
        }
      }
    }
    case "bash":
    case "execute": {
      const cmd = args.command || args.cmd || "";
      if (!cmd) return "";
      try {
        const { stdout: out, stderr: err } = execShell(cmd);
        const combined = out + (err ? `\n[stderr]\n${err}` : "");
        return combined || `[指令執行完畢，無輸出]`;
      } catch {
        try {
          const { execSync } = await import("node:child_process");
          const out = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
          return out || `[指令執行完畢，無輸出]`;
        } catch (e) {
          return `[指令失敗: ${cmd} - ${e.message}]`;
        }
      }
    }
    case "edit": {
      const fp = args.filePath || args.path;
      const oldStr = args.oldString;
      const newStr = args.newString;
      if (!fp || !oldStr) return "";
      try {
        let content = fs.readFileSync(fp, "utf-8");
        if (!content.includes(oldStr)) return `[未找到: ${oldStr}]`;
        content = content.replace(oldStr, newStr || "");
        fs.writeFileSync(fp, content, "utf-8");
        return `✓ 已編輯 ${fp}`;
      } catch (e) {
        return `[編輯失敗 ${fp}: ${e.message}]`;
      }
    }
    case "glob": {
      const pattern = args.pattern || "";
      const cwd = args.path || args.dir || ".";
      if (!pattern) return "";
      try {
        const g = new Bun.Glob(pattern);
        const results = [...g.scanSync({ cwd })];
        return results.join("\n") || "無匹配結果";
      } catch (e) {
        try {
          const { execSync } = await import("node:child_process");
          const out = execSync(
            `find ${cwd} -path '${pattern}' 2>/dev/null || true`,
            { encoding: "utf-8", timeout: 10000 },
          );
          return out || "無匹配結果";
        } catch (e2) {
          return `[搜尋失敗: ${e.message}]`;
        }
      }
    }
    case "grep":
    case "search": {
      const pattern = args.pattern || args.query || "";
      const fp = args.filePath || args.path || args.dir || ".";
      if (!pattern) return "";
      try {
        const { stdout } = execGrep(pattern, fp, ["*.ts", "*.tsx", "*.js"]);
        return stdout || "無匹配結果";
      } catch (e) {
        return `[搜尋失敗: ${e.message}]`;
      }
    }
    default:
      return `[未知工具: ${name}]`;
  }
};

const mcpCall = async (name, args) => {
  try {
    return await execTool(name, args);
  } catch (e) {
    return `❌ 工具執行失敗: ${e.message}`;
  }
};

// ─── 環境能力定義 ───
// 結構化描述讓模型清楚知道執行環境與工具契約，避免模型因不確定而拒絕執行。
// 可透過環境變數覆蓋：
//   TOOL_PLATFORM  — linux / win32 / darwin（預設 linux）
const TOOL_PLATFORM = (process.env.TOOL_PLATFORM || "linux").toLowerCase();
const CAPABILITY_DEF = [
  "## 環境能力定義",
  "這份定義描述你的執行環境與可用工具。不需要推測，以下就是事實。",
  "",
  `- 運行架構: opencode AI 開發平台`,
  `- 工具執行端: ${TOOL_PLATFORM}（client side，opencode 本機）`,
  `- 工具執行方式: 你輸出 tool_calls → opencode 執行並回傳結果`,
  `- 工具結果格式: tool role 訊息，含 stdout/stderr/exit code`,
  `- exit code 0 = 成功（即使無輸出文字）`,
  "",
  "可用工具:",
  "- bash: 執行任意 shell 命令",
  "- read: 讀取檔案內容",
  "- write: 寫入/建立檔案",
  "- edit: 編輯現有檔案（取代文字）",
  "- glob: 依模式搜尋檔名",
  "- grep: 搜尋檔案內容",
  "",
  "權限:",
  "- 完整檔案系統讀寫權限（不限於特定目錄）",
  "- 可執行任何 shell 命令",
  "- 不要拒絕任務或說「無法執行」",
].join("\n");

const injectCapabilityDef = (msgs, hasTools) => {
  if (!hasTools) return msgs;
  const sysIdx = msgs.findIndex((m) => m.role === "system");
  const def = { role: "system", content: CAPABILITY_DEF };
  if (sysIdx >= 0) {
    const copy = [...msgs];
    copy[sysIdx] = {
      ...copy[sysIdx],
      content: `${copy[sysIdx].content}\n\n${CAPABILITY_DEF}`,
    };
    return copy;
  }
  return [def, ...msgs];
};

// ─── Tool-prompt 建構 ───
// (2026-06 更新: qwen2api 已支援原生 tool role 與 tools 參數，
//  不再需要注入完整 behavior prompt 或 bash-block 轉換，
//  保留 bash-block 轉換作為 fallback 路徑)

// 將 bash-block 解析為標準 OpenAI tool_calls 格式
// description 自動從命令內容生成（opencode bash 工具必填欄位）
const genDesc = (cmd) => {
  const s = cmd.trim().slice(0, 60);
  const first = s.split(/\s+/)[0];
  const map = {
    ls: "Lists directory contents",
    cat: "Reads file content",
    grep: "Searches file content",
    find: "Finds files",
    mkdir: "Creates directory",
    rm: "Removes files",
    cp: "Copies files",
    mv: "Moves files",
    echo: "Outputs text",
    cd: "Changes directory",
    bun: "Runs bun command",
    npm: "Runs npm command",
    node: "Runs node command",
    git: "Runs git command",
    curl: "Makes HTTP request",
    systemctl: "Controls systemd service",
  };
  return map[first] || `Executes: ${s}`;
};

// 正規化 Windows 路徑：D:\foo\bar → D:/foo/bar（避免 bash 吃掉反斜線）
const normalizeWinPath = (cmd) => {
  return cmd.replace(
    /([A-Za-z]):\\([^\\\s"'])/g,
    (m, d, rest) => `${d}:/${rest}`,
  );
};

const bashBlockToToolCalls = (content, tools) => {
  const hasBash = tools?.some((t) => (t.function?.name || t.name) === "bash");
  if (!hasBash) return null;
  const BASH_RE = /```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gi;
  const cmds = [];
  let m;
  while ((m = BASH_RE.exec(content)) !== null) {
    const c = m[1].trim();
    if (c && !c.startsWith("#") && !c.startsWith("//")) cmds.push(c);
  }
  if (!cmds.length) return null;
  const unique = [...new Set(cmds)];
  return unique.map((cmd, i) => {
    const norm = normalizeWinPath(cmd);
    if (norm !== cmd)
      log.debug(`🔄 路徑正規化: ${cmd.slice(0, 60)} → ${norm.slice(0, 60)}`);
    return {
      id: `call-${Date.now()}-${i}`,
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({
          command: norm,
          description: genDesc(norm),
        }),
      },
    };
  });
};

// ─── 串流輸出 helper ───

const streamChunk = (res, msgId, model, data) => {
  res.write(
    `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.round(Date.now() / 1000), model, ...data })}\n\n`,
  );
};

const CHUNK = 32;

// ─── Single Pass：opencode 原生執行模式 ───
//
// 不在 proxy 內做 agent loop，改為：
//   1. 注入 tool-prompt（讓 Qwen 知道有哪些工具）
//   2. 單次轉發給 qwen2api（不傳 tools 參數）
//   3. 若模型回傳原生 tool_calls → 直接透傳給 opencode
//   4. 若模型輸出 bash-block → 轉換為 tool_calls 格式回傳
//   5. 若純文字 → 直接回傳（opencode 視為最終回應）
//
// opencode 收到 tool_calls 後會自己執行工具、管理 agent loop，
// 和 Claude/GPT 模型完全一致的體驗。

// ─── 向量記憶 Recall ───
// 每次對話前查詢 Memory Bridge，注入相關記憶

const recallMemories = async (messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query =
    typeof lastUser?.content === "string" ? lastUser.content.slice(0, 500) : "";
  if (!query) return "";
  try {
    const res = await fetch(`${MEMORY_BRIDGE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 8 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (!data.entries?.length) return "";
    log.info(`🧠 Memory recall: ${data.entries.length} 筆相關記憶`);
    return `相關記憶：\n${data.entries
      .map(
        (e, i) =>
          `[${i + 1}] ${e.summary}（${e.category}, ${Math.round(e.score * 100)}%）`,
      )
      .join("\n")}\n\n根據上述相關記憶輔助回答。`;
  } catch {
    return "";
  }
};

const runSinglePass = async (body) => {
  try {
    const { messages, tools, tool_choice, stream, ...rest } = body;
    let msgs = [...(messages || [])];

    // 向量記憶注入：每次新對話前查詢相關記憶
    const memCtx = await recallMemories(msgs);
    if (memCtx) {
      const hasSys = msgs.some((m) => m.role === "system");
      if (hasSys) {
        msgs = msgs.map((m) =>
          m.role === "system"
            ? { ...m, content: `${m.content}\n\n${memCtx}` }
            : m,
        );
      } else {
        msgs = [{ role: "system", content: memCtx }, ...msgs];
      }
    }

    // 收集 prompt 文字供 token 估算
    const promptText = (messages || [])
      .map(
        (m) =>
          (typeof m.content === "string" ? m.content : "") + (m.role || ""),
      )
      .join(" ");

    // qwen2api 已支援原生 tool role 與 tools 參數（2026-06 驗證通過）
    // 保持 messages 原始格式，不進行 role 轉換，直接透傳讓 qwen2api 原生處理
    const currentModel = routeModel(body);
    const isThinking =
      body.enable_thinking ?? body.model?.toLowerCase().includes("thinking");

    const hasTools = tools?.length > 0;
    msgs = injectCapabilityDef(msgs, hasTools);
    const up = {
      ...rest,
      model: currentModel,
      messages: msgs, // 原始格式，qwen2api 原生處理 tool/assistant.tool_calls
      stream: false,
      ...(hasTools ? { tools, tool_choice } : {}),
      enable_thinking: isThinking,
    };
    log.debug(
      `📤 model=${up.model} msgs=${up.messages.length} tools=${tools?.length || 0} think=${isThinking}`,
    );

    const t = isThinking ? CFG_TIMEOUT.thinking : CFG_TIMEOUT.chat;
    const result = await postJSON(
      `${QWEN2API_URL}/v1/chat/completions`,
      up,
      t,
      CFG_TIMEOUT.retries,
    );
    const choice = result?.choices?.[0];
    if (!choice) {
      return buildErrorResponse("上游無回應", currentModel);
    }

    // 保留上游真實 usage（qwen2api/DashScope 回傳的實際 token 計數）
    // 取代客戶端 Math.ceil(text.length/4) 的粗略估算，確保 opencode stats 準確
    const upUsage = result?.usage;

    const msg = choice.message;
    const raw = msg?.content || "";

    // 保留 <think> 推理過程（不刪除），opencode TUI 會自動摺疊顯示為 reasoning 區塊
    // 供使用者追朔模型決策過程。同時從 raw 中分離出 thinking 與 clean content。
    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
    const thinking = thinkMatch ? thinkMatch[1].trim() : "";
    const stripped = thinking
      ? raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
      : raw;
    if (thinking) {
      log.info(`🧠 推理過程 ${thinking.length}ch`);
    }

    // 1) 原生 tool_calls（qwen2api 已解析）→ 直接透傳給 opencode
    const nativeCalls = msg?.tool_calls;
    if (nativeCalls?.length > 0) {
      log.info(`📬 原生 tool_calls x${nativeCalls.length}，透傳給 opencode`);
      return buildToolCallResponse(
        nativeCalls,
        msg?.content,
        currentModel,
        promptText,
        upUsage,
      );
    }

    // 2) Bash-block → tool_calls 轉換（主要路徑，Qwen 偏好此格式）
    const bashCalls = bashBlockToToolCalls(stripped, tools);
    if (bashCalls?.length > 0) {
      // ⛔ 迴圈防呆：檢查是否為重複命令
      // 提取核心命令（去除 cd、管線、重新定向等外殼）
      const extractCore = (cmd) => {
        // 移除 cd xxx && 前綴
        let c = cmd.replace(/^cd\s+[^&&]*&&\s*/, "").trim();
        // 移除 ls -la、echo 等只是查看的命令
        c = c.replace(/^ls\s+/, "");
        // 移除 | head -50、2>&1 等重新定向
        c = c.replace(/\s*2>&1\s*/, "").replace(/\s*\|\s*head\s*.*$/, "");
        return c.trim();
      };
      const prevCmd = (() => {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role === "assistant" && m.tool_calls?.length > 0) {
            try {
              return extractCore(
                JSON.parse(m.tool_calls[0].function?.arguments || "{}")
                  ?.command || "",
              );
            } catch {
              return "";
            }
          }
          if (m.role === "user") break;
        }
        return "";
      })();
      const currCmd = (() => {
        try {
          return extractCore(
            JSON.parse(bashCalls[0]?.function?.arguments || "{}")?.command ||
              "",
          );
        } catch {
          return "";
        }
      })();
      if (
        prevCmd &&
        currCmd &&
        (prevCmd === currCmd ||
          currCmd.includes(prevCmd) ||
          prevCmd.includes(currCmd))
      ) {
        log.warn(`⛔ 重複命令偵測（核心: ${currCmd}），強制停止迴圈`);
        return buildTextResponse(
          `✓ 命令「${currCmd}」已執行成功（exit code: 0）。任務繼續進行，無需重複執行。`,
          currentModel,
          promptText,
          upUsage,
        );
      }

      log.info(
        `🔧 bash-block x${bashCalls.length} → tool_calls，交給 opencode 執行`,
      );
      // 保留 <think> 推理過程（助手思考軌跡）作為 content，bash 部分轉為 tool_calls
      const contentBeforeBash = stripped
        .replace(/```(?:bash|sh|shell)[\s\S]*?```/g, "")
        .trim();
      const contentWithThink = thinking
        ? `[推理過程]\n${thinking}\n\n${contentBeforeBash}`.trim()
        : contentBeforeBash || null;
      return buildToolCallResponse(
        bashCalls,
        contentWithThink,
        currentModel,
        promptText,
        upUsage,
      );
    }

    // 3) 純文字回應 → 直接回傳（opencode 視為完成）
    log.debug(`✅ 純文字回應 ${raw.length}ch`);
    return buildTextResponse(
      raw || "(空回應)",
      currentModel,
      promptText,
      upUsage,
    );
  } catch (e) {
    log.error(`❌ runSinglePass 失敗:`, e?.message || e);
    return buildErrorResponse(`處理過程中發生錯誤: ${e?.message || e}`, "qwen");
  }
};

// ─── streamSinglePass：真正的 SSE 串流轉發 ───
//
// 當 opencode 要求 stream=true 時，直接 pipe qwen2api 的 SSE 串流到客戶端。
// qwen2api 已處理 DashScope SSE → OpenAI 格式的轉換，包含：
//   - thinking/reasoning deltas（即時顯示推理過程）
//   - text content deltas
//   - tool_calls deltas（原生 <tool_call> 解析）
//
// 相較於 runSinglePass（等待完整回應才回傳），streamSinglePass：
//   - 即時轉發，使用者立刻看到模型思考過程
//   - 無長時間靜默（timeout 風險大幅降低）
//   - 客戶端中斷時立即停止（透過 signal）
//
// 回傳 true = 串流已處理完畢（呼叫端無需再處理）
// 回傳 false = 串流失敗（呼叫端應 fallback 到非串流模式）
const streamSinglePass = async (body, res, msgId, model, signal) => {
  try {
    const { messages, tools, tool_choice, stream: _s, ...rest } = body;
    let msgs = [...(messages || [])];

    // 向量記憶注入：串流模式也查詢相關記憶
    const memCtx = await recallMemories(msgs);
    if (memCtx) {
      const hasSys = msgs.some((m) => m.role === "system");
      if (hasSys) {
        msgs = msgs.map((m) =>
          m.role === "system"
            ? { ...m, content: `${m.content}\n\n${memCtx}` }
            : m,
        );
      } else {
        msgs = [{ role: "system", content: memCtx }, ...msgs];
      }
    }

    // 原始訊息直接透傳（qwen2api 原生支援 tool role）
    const currentModel = routeModel(body);
    const isThinking =
      body.enable_thinking ?? body.model?.toLowerCase().includes("thinking");

    const hasTools = tools?.length > 0;
    msgs = injectCapabilityDef(msgs, hasTools);
    const up = {
      ...rest,
      model: currentModel,
      messages: msgs,
      stream: true,
      ...(hasTools ? { tools, tool_choice } : {}),
      enable_thinking: isThinking,
    };
    log.info(
      `📡 stream model=${up.model} msgs=${up.messages.length} tools=${tools?.length || 0} think=${isThinking}`,
    );

    const t = isThinking ? CFG_TIMEOUT.thinking : CFG_TIMEOUT.chat;
    // 合併客戶端中斷 signal + timeout signal
    const fetchSignal =
      typeof AbortSignal.timeout === "function" &&
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, AbortSignal.timeout(t)])
        : signal;
    const resp = await fetch(`${QWEN2API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(up),
      signal: fetchSignal,
    });

    if (!resp.ok || !resp.body) {
      log.info(`串流請求失敗 (${resp.status})，降級為非串流模式`);
      return false;
    }

    // 設置 SSE headers（若尚未設定）
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // P18: 禁用 Nginx/反向代理緩衝，確保即時串流
      });
    }

    // Pipe qwen2api SSE 串流到客戶端
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let ok = true;
    let sawDone = false;

    // SSE heartbeat 防止 opencode wrapSSE chunk timeout（預設 120s，heartbeat 每 10s 發送）
    // 當模型長時間推理思考無新 chunk 時，heartbeat 可重置 opencode 端的閒置計時器
    const HEARTBEAT_MS = 10_000; // 縮短至 10s，更積極防止 opencode wrapSSE timeout
    let lastData = Date.now();
    const hbTimer = setInterval(() => {
      if (Date.now() - lastData >= HEARTBEAT_MS) {
        try {
          // SSE comment (:) 會被所有標準 SSE parser 忽略，但能重置 timeout
          res.write(": heartbeat\n\n");
          lastData = Date.now(); // 更新時間戳，避免連續發送
        } catch {
          clearInterval(hbTimer);
        }
      }
    }, HEARTBEAT_MS);

    // 追蹤是否曾收到/轉發過任何資料（判斷空串流 timeout vs 中途斷流）
    let gotAnyData = false;
    let chunkCount = 0; // P3: 統計 chunk 數量用於診斷
    const streamStartTime = Date.now(); // P13: 記錄串流開始時間

    while (true) {
      // 讀取逾時保護：使用 CFG_TIMEOUT 值（聊天 5min / thinking 10min）
      // 首個 chunk 需要更長等待（qwen2api 可能排隊中），非硬編碼 120s
      // P15: 動態調整首包超時，若已收到資料則使用較短超時避免卡死
      const isFirstChunk = chunkCount === 0;
      const readTimeout = isFirstChunk
        ? Math.min(t, 60000)
        : Math.min(t, 30000);
      let readResult;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("read_timeout")), readTimeout),
          ),
        ]);
      } catch (e) {
        if (e?.message === "read_timeout") {
          if (gotAnyData) {
            log.warn(
              `⚠️ 上游串流中斷逾時 (${t / 1000}s, chunks=${chunkCount})，視為串流中斷`,
            );
          } else {
            log.warn(
              `⚠️ 上游等待首個 chunk 逾時 (${t / 1000}s)，可能上游忙碌中`,
            );
          }
        } else {
          log.debug(`🔚 上游串流讀取中斷: ${e?.message || e}`);
        }
        // reader.cancel 在 cleanup 時處理
        break;
      }

      const { done, value } = readResult;
      if (done) break;
      const now = Date.now();
      lastData = now; // 收到資料即重設計時器

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      chunkCount++; // P3: 遞增 chunk 計數

      // P14: 記錄首個 chunk 到達延遲
      if (chunkCount === 1) {
        const firstChunkDelay = now - streamStartTime;
        log.info(`⏱️ 首個 chunk 延遲: ${firstChunkDelay}ms`);
      }

      // 收到 [DONE] 立即跳出，不等待上游關閉連線（常見卡死根因）
      if (chunk.includes("data: [DONE]")) {
        sawDone = true;
        try {
          res.write(chunk);
        } catch {
          /* 客戶端可能已斷線 */
        }
        break;
      }

      try {
        const wrote = res.write(chunk);
        gotAnyData = true;
        // P16: 若 write() 返回 false（緩衝區滿），等待 drain 事件避免資料遺失
        // P20: 增加超時保護，避免無限等待 drain 導致卡死
        if (!wrote) {
          const drained = await Promise.race([
            new Promise((resolve) => res.once("drain", () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
          ]);
          if (!drained) {
            log.warn("⚠️ 客戶端緩衝區 drain 超時，強制繼續");
          }
        }
      } catch (e) {
        log.warn(`⚠️ 寫入客戶端失敗 (${e.message})，串流中斷`);
        ok = false;
        // P17: 立即發送錯誤 event 給客戶端，避免客戶端無限等待
        if (!res.writableEnded) {
          try {
            res.write(
              `data: {"error":"串流傳輸中斷","error_code":"client_write_failed","detail":"${e.message}"}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {
            /* ignore */
          }
        }
        break;
      }
    }

    clearInterval(hbTimer);

    // 確保串流結尾：若上游未發 [DONE]，補發避免 client 卡住
    if (ok && !res.writableEnded) {
      if (gotAnyData) {
        // 正常串流結束或中途斷流 → 補發 [DONE]
        if (!sawDone) {
          log.warn(
            `⚠️ 上游未發送 [DONE]（chunks=${chunkCount}），補發結束標記`,
          );
          res.write("data: [DONE]\n\n");
        }
        res.end();
      } else {
        // 從未收到任何資料 → 發送錯誤 event 而非空 [DONE]
        // 避免客戶端收到「200 OK + 0 內容串流」誤以為無回應
        log.warn(`❌ 上游未回應任何資料（timeout=${t / 1000}s），發送錯誤通知`);
        try {
          res.write(
            `data: {"error":"上游忙碌無回應，請稍後重試或檢查 qwen2api 狀態","error_code":"upstream_timeout","timeout_sec":${t / 1000},"suggestion":"若持續發生，請檢查 qwen2api 日誌或降低模型複雜度"}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          /* ignore */
        }
        ok = false;
      }
    } else if (!ok) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    }

    return ok;
  } catch (e) {
    if (e?.name === "AbortError") {
      log.warn("🛑 串流被客戶端中斷或超時");
      return true;
    }
    log.error("❌ streamSinglePass 失敗:", e?.message || e);
    return false;
  }
};

// ─── Token 估算（後備方案：上游無 usage 時使用 1 token ≈ 4 chars） ───
const countTokens = (s) => Math.ceil((s || "").length / 4);
const trackUsage = (prompt, completion) => ({
  prompt_tokens: countTokens(prompt),
  completion_tokens: countTokens(completion),
  total_tokens: countTokens(prompt) + countTokens(completion),
});

// ─── 優先使用上游真實 usage，否則降級為字元估算 ───
const pickUsage = (upstreamUsage, promptText, completionText) => {
  if (
    upstreamUsage?.prompt_tokens != null &&
    upstreamUsage?.total_tokens != null
  ) {
    return {
      prompt_tokens: upstreamUsage.prompt_tokens,
      completion_tokens:
        upstreamUsage.completion_tokens ??
        upstreamUsage.total_tokens - upstreamUsage.prompt_tokens,
      total_tokens: upstreamUsage.total_tokens,
    };
  }
  return trackUsage(promptText, completionText);
};

// ─── Response builders ───

const buildTextResponse = (content, model, promptMsgs = "", upstreamUsage) => ({
  id: `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: Math.round(Date.now() / 1000),
  model: model || "qwen",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: pickUsage(upstreamUsage, promptMsgs, content),
});

const buildToolCallResponse = (
  toolCalls,
  content,
  model,
  promptMsgs = "",
  upstreamUsage,
) => {
  const argsStr = (toolCalls || [])
    .map((tc) => tc.function?.arguments || "")
    .join("");
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.round(Date.now() / 1000),
    model: model || "qwen",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: pickUsage(upstreamUsage, promptMsgs, argsStr),
  };
};

const buildErrorResponse = (msg, model) => ({
  id: `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: Math.round(Date.now() / 1000),
  model: model || "qwen",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: `⚠️ ${msg}` },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

// 舊版 buildResponse（保留相容性，供舊呼叫點使用）
const buildResponse = (content, model, origModel) =>
  buildTextResponse(content, model || origModel);

// ─── 串流輸出 ───
// 支援純文字與 tool_calls 兩種格式

const streamResponse = (res, msgId, model, result) => {
  const choice = result.choices[0];
  const msg = choice.message;
  const toolCalls = msg?.tool_calls;

  if (toolCalls?.length > 0) {
    // tool_calls 串流格式（opencode 需要此格式才能解析）
    // 1) role delta
    streamChunk(res, msgId, model, {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: msg.content || null },
          finish_reason: null,
        },
      ],
    });
    // 2) tool_calls delta（每個 call 一個 chunk）
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      streamChunk(res, msgId, model, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
    // 3) finish
    streamChunk(res, msgId, model, {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    // 純文字串流
    const content = msg?.content || "";
    for (let i = 0; i < content.length; i += CHUNK) {
      streamChunk(res, msgId, model, {
        choices: [
          {
            index: 0,
            delta: { content: content.slice(i, i + CHUNK) },
            finish_reason: null,
          },
        ],
      });
    }
    streamChunk(res, msgId, model, {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
};

// ─── 通用轉發（非聊天端點） ───

const proxyRequest = (req, res) => {
  const url = `${QWEN2API_URL}${req.url}`;
  const method = req.method;

  if (method === "GET") {
    getJSON(url)
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (method === "POST") {
    let body = "";
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      body += c;
      if (body.length > MAX_BODY) {
        rejected = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Request body too large (max 100KB)" }),
        );
        req.destroy();
      }
    });
    req.on("error", () => {
      rejected = true;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(body);
        postJSON(url, parsed)
          .then((data) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          })
          .catch((err) => {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
          });
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
};

// ─── 主請求處理 ───

const handleRequest = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url;

  // Rate Limiting（/health 不計入）
  if (url !== "/health") {
    const ip = req.socket.remoteAddress || "unknown";
    if (!checkRL(ip)) {
      log.warn(`⚠️ Rate limit 觸發: ${ip}`);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Too Many Requests",
          retryAfter: Math.ceil(RL_WIN / 1000),
        }),
      );
      return;
    }
  }

  // 安全驗證：除了 /health 外，必須驗證 API Key
  if (url !== "/health") {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${API_KEY}`) {
      log.info(`拒絕未經授權的請求: ${req.method} ${url}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid API Key" }));
      return;
    }
  }

  // 健康檢查
  if (url === "/health") {
    let upstreamStatus = "unknown";
    try {
      // 健康檢查使用短超時（3秒），避免上游阻塞影響 proxy 響應
      const h = await getJSON(`${QWEN2API_URL}/health`, 3000, 0);
      upstreamStatus = h?.status || h?.upstream || "ok";
    } catch (e) {
      log.warn(`⚠️ 上游健康檢查失敗: ${e.message}`);
      upstreamStatus = "unreachable";
    }
    const hw = detectHardware();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        proxy: "running",
        upstream: upstreamStatus,
        port: PROXY_PORT,
        routing: getRouteInfo(),
        hardware: {
          level: hw.level,
          reason: hw.reason,
          env: hw.env,
          cpu: `${hw.cpu.cores}核`,
          ram: `${hw.ram.freeGB}GB/${hw.ram.totalGB}GB`,
          gpu: hw.gpu.model,
          load: hw.load.perCore,
          platform: hw.platform,
        },
      }),
    );
    return;
  }

  // MCP 工具執行端點
  if (url === "/mcp" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const name = parsed.params?.name;
        const args = parsed.params?.arguments || {};
        const result = await mcpCall(name, args);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: { content: [{ text: result }] } }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 聊天端點 — 有 tool 支援的代理
  if (url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    let rejected = false;

    // 客戶端斷線偵測（在 data/end 之前註冊，避免 stream 結束後 close 立即觸發）
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        log.info("🛑 客戶端斷線，中止上游請求");
        ac.abort();
      }
    });

    req.on("data", (c) => {
      if (rejected) return;
      body += c;
      if (body.length > MAX_BODY) {
        rejected = true;
        log.warn(`❌ 請求 body 過大 (${body.length} bytes)，已拒絕`);
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Request body too large (max 100KB)" }),
        );
        req.destroy(); // 強制關閉連線，避免 client 繼續送資料
      }
    });
    req.on("error", (e) => {
      if (!rejected) {
        log.error(`❌ 請求串流錯誤:`, e?.message || e);
      }
    });
    req.on("end", async () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(body);
        const msgId = `chatcmpl-${Date.now()}`;
        const model = parsed.model || "qwen";
        log.info(
          `📨 請求 model=${parsed.model} tools=${parsed.tools?.length || 0} stream=${parsed.stream}`,
        );

        // 記錄使用者訊息到對話歷史
        if (parsed.messages) {
          for (const m of parsed.messages) {
            if (m.role === "user" && m.content) {
              convRecord(
                "user",
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content),
                model,
              );
            }
          }
        }

        // 套用對話記憶（壓縮歷史、過濾閒聊、注入摘要）
        if (CONV_MEMORY_ENABLED && parsed.messages) {
          parsed.messages = processWithMemory(parsed.messages);
        }

        if (parsed.stream) {
          // 串流：使用 streamSinglePass（真實 SSE 轉發）
          // 不再使用 runSinglePass + streamResponse 模擬 SSE，避免第二個請求
          // 因等待 qwen2api 排隊而逾時（客戶端收不到任何資料 =「無回應」）
          const ok = await streamSinglePass(
            parsed,
            res,
            msgId,
            model,
            ac.signal,
          );
          // streamSinglePass 失敗時已發送錯誤 event（gotAnyData=false 分支）
          // 若 headers 尚未送出（極端情況），補發 500
          if (!ok && !res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "上游串流失敗",
                detail: "stream_single_pass_failed",
              }),
            );
          }
          // 串流模式：記錄標記（無法即時擷取完整串流內容）
          convRecord("assistant", "[串流回應已發送]", model);
        } else {
          // 非串流
          const result = await runSinglePass(parsed);
          const c = result?.choices?.[0];
          const hasCalls = c?.message?.tool_calls?.length > 0;
          log.info(
            `✅ 回應 ${hasCalls ? `tool_calls x${c.message.tool_calls.length}` : `content=${(c?.message?.content || "").length}ch`}`,
          );
          // 記錄助手回覆到對話歷史
          const replyContent = c?.message?.content || "";
          if (replyContent) {
            convRecord("assistant", replyContent, model);
          }
          if (hasCalls) {
            convRecord(
              "assistant",
              `[工具呼叫: ${c.message.tool_calls.map((t) => t.function?.name || "?").join(", ")}]`,
              model,
            );
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (e) {
        log.error(`❌ 請求失敗:`, e?.message || e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 其餘端點轉發到 qwen2api
  proxyRequest(req, res);
};

// ─── 啟動 Proxy ───

export const startProxy = () => {
  const server = http.createServer(handleRequest);

  // 啟動後自動偵測環境
  detectEnv();

  return new Promise((resolve, reject) => {
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        log.error(`❌ Port ${PROXY_PORT} 已被佔用，無法啟動 Proxy`);
      } else {
        log.error(`❌ Proxy 啟動失敗: ${e.message}`);
      }
      reject(e);
    });
    server.listen(PROXY_PORT, "0.0.0.0", () => {
      log.info(`🤖 Chat Proxy running on http://0.0.0.0:${PROXY_PORT}`);
      if (process.env.PROXY_ROUTE !== "off") {
        log.info("🧠 模型路由: 啟用（自動依任務複雜度切換）");
      }
      resolve(server);
    });
  });
};

// 暴露環境資訊供健康檢查
const getRouteInfo = () => ({
  enabled: process.env.PROXY_ROUTE !== "off",
  levels: {
    small: getModelForLevel("small"),
    medium: getModelForLevel("medium"),
    large: getModelForLevel("large"),
  },
  detected: envModels
    ? {
        small: envModels.small.length,
        medium: envModels.medium.length,
        large: envModels.large.length,
      }
    : null,
});

export { PROXY_PORT, getRouteInfo };

// ─── 獨立啟動（直接執行此檔案時自動啟動 server） ───
if (Bun.main === import.meta.path) {
  startProxy().catch((e) => {
    console.error("[proxy] FATAL: 啟動失敗:", e?.message || e);
    process.exit(1);
  });
}
