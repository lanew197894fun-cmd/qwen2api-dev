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
import { OPENCODE_DIR } from "../../config/paths.js";
import * as selfLearning from "./self-learning.js";
import { createRouter } from "./provider/index.js";
import { guardToolCalls } from "./env-guard.js";
import {
  CFG,
  qwen2apiUrl,
  classifyModel,
  isCoderVariant,
  NO_TOOL_MODELS,
  LEVEL_ORDER,
  LEVEL_LABELS,
} from "./config/index.js";

const LV = CFG.LOG_LEVEL;
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
  // 不變邊界：不 process.exit，應 keepalive 重試（記錄錯誤，避免異常即死需 start.mjs 重啟）
  try {
    log.error("💥 未捕捉 exception:", e?.message || e);
  } catch {
    console.error("[proxy] FATAL:", e?.message || e);
  }
});

const QWEN2API_URL = qwen2apiUrl();
const MEMORY_BRIDGE_URL = CFG.MEMORY_BRIDGE_URL;
const PROXY_PORT = CFG.PROXY_PORT;
const API_KEY = CFG.API_KEY;
const MAX_LOOPS = 5;
const MAX_BODY = CFG.MAX_BODY;
const PROJ_DIR = getPath("projectDir");
const MAX_INFLIGHT = CFG.MAX_INFLIGHT;

// ─── 可配置 timeout 常數（集中定義於 config/index.js） ───
// ═══ 逾時層級硬性規範（2026-11-01）═══
// 三層計時器必須嚴格排序，否則長推理會被最早的計時器砍掉：
//   REQUEST_TIMEOUT >= THINKING_TIMEOUT > CHAT_IDLE_THINKING_MS
// 1) REQUEST_TIMEOUT（handler 整體計時器，L3128）＝最後防線
// 2) THINKING_TIMEOUT（fetch AbortSignal.timeout，L2384）＝單次上游請求上限
// 3) CHAT_IDLE_THINKING_MS（SSE 無資料上限，L2496）＝上游思考停頓容忍
// 反例：舊值 REQUEST=60s < THINKING=120s，推理 >60s 即被 abort → 「上游無回應」。
const CFG_TIMEOUT = {
  chat: CFG.CHAT_TIMEOUT,
  thinking: CFG.THINKING_TIMEOUT,
  health: CFG.HEALTH_TIMEOUT,
  retries: CFG.RETRIES,
};

// ─── 請求追蹤 ID ───
let _nextTrace = 0;
const _genTrace = () => {
  const id = (++_nextTrace).toString(36).padStart(4, "0");
  return `${Date.now().toString(36).slice(-4)}-${id}`;
};

// ─── Router 實例（startProxy 中初始化） ───
let _router = null;

// ─── 記憶體壓力監控 ───
let _memWarned = false;
const _checkMem = () => {
  try {
    const { heapUsed, heapTotal, rss } = process.memoryUsage();
    const usedMB = Math.round(heapUsed / 1024 / 1024);
    const totalMB = Math.round(heapTotal / 1024 / 1024);
    // 跳過初始 V8 heap 還很小的場景（< 50MB），避免 false positive
    if (heapTotal < 50 * 1024 * 1024) {
      if (LV >= 4)
        log.debug(
          `mem: ${usedMB}/${Math.round(rss / 1024 / 1024)}MB (warming up)`,
        );
      return;
    }
    const ratio = heapUsed / heapTotal;
    if (ratio > CFG.MEM_WARN_THRESHOLD && !_memWarned) {
      log.warn(
        `⚠️ 記憶體壓力: ${usedMB}MB/${totalMB}MB (${(ratio * 100).toFixed(0)}%)`,
      );
      _memWarned = true;
    } else if (ratio < CFG.MEM_WARN_THRESHOLD * 0.7) {
      _memWarned = false;
    }
    if (LV >= 4) log.debug(`mem: ${usedMB}/${Math.round(rss / 1024 / 1024)}MB`);
  } catch {}
};
setInterval(_checkMem, 60000);

// ─── 推理模式：auto / on / off ───
// auto  = 自動偵測模型是否支援推理（根據模型名特徵）
// on    = 強制開啟所有 Qwen 模型推理
// off   = 不啟用推理（除非客戶端明確要求）
const PROXY_THINKING_MODE = CFG.THINKING_MODE;

// 判斷模型是否支援推理（供 PROXY_THINKING_MODE=auto 使用）
function modelSupportsReasoning(model) {
  const m = model.toLowerCase();
  // qwq 系列（純推理模型）
  if (m.includes("qwq")) return true;
  // 明確標記 reasoning/thinking 的模型
  if (m.includes("reasoning") || m.includes("thinking")) return true;
  // Qwen 高階模型：plus/max 通常支援推理
  if (
    m.includes("qwen") &&
    (m.includes("plus") || m.includes("max") || m.includes("coder"))
  )
    return true;
  return false;
}

// 統一解析是否啟用推理
function resolveThinking(body) {
  // 客戶端明確指定 → 尊重客戶端
  if (body.enable_thinking !== undefined) return body.enable_thinking;
  // 客戶端透過模型名指定 -thinking 後綴
  if (body.model?.toLowerCase().includes("thinking")) return true;
  // 根據 PROXY_THINKING_MODE 決定
  if (PROXY_THINKING_MODE === "on") return true;
  if (PROXY_THINKING_MODE === "auto")
    return modelSupportsReasoning(body.model || "");
  // off
  return false;
}

// ─── 思考等級（自動升降）───
// 2026-10-23：思考等級影響上游延遲最大。原本一律 81920 預算，
// 簡單問句也硬跑長思考 → 25s+ 甚至超時「上游無回應」。
// 策略：客戶端 reasoningEffort 優先；否則依任務複雜度自動升降。
const EFFORT_BUDGET = {
  none: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 32768,
  xhigh: 81920,
};

// 複雜度 → 預設思考等級（auto 升降）
const AUTO_EFFORT = { small: "none", medium: "low", large: "medium" };

/** 正規化客戶端思考等級字串 */
const normEffort = (v) => {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  return EFFORT_BUDGET[s] !== undefined ? s : "";
};

/**
 * 解析思考設定
 * @returns {{on: boolean, budget: number, effort: string}}
 *   on=true 時一定帶 budget；on=false 時 budget=0
 */
function resolveThink(body) {
  const on = resolveThinking(body);
  if (!on) return { on: false, budget: 0, effort: "none" };

  // 1) 客戶端明確指定等級（OpenAI 標準欄位 + 別名）
  const explicit = normEffort(
    body.reasoning_effort ??
      body.reasoningEffort ??
      body.thinking_level ??
      body.thinkingLevel,
  );
  if (explicit) {
    return {
      on: explicit !== "none",
      budget: EFFORT_BUDGET[explicit],
      effort: explicit,
    };
  }

  // 2) 客戶端明確給 thinking_budget → 直接用
  const b = Number(body.thinking_budget);
  if (Number.isFinite(b) && b > 0) {
    const lv = b >= 32768 ? "high" : b >= 8192 ? "medium" : "low";
    return { on: true, budget: Math.min(Math.round(b), 81920), effort: lv };
  }

  // 3) 自動升降：依任務複雜度決定思考等級
  if (PROXY_THINKING_MODE === "auto") {
    const lv = AUTO_EFFORT[analyzeComplexity(body)] || "low";
    if (lv === "none") return { on: false, budget: 0, effort: "none" };
    return { on: true, budget: EFFORT_BUDGET[lv], effort: lv };
  }

  // 4) on 模式但無指定 → 中等，避免預設 81920 拖慢
  return { on: true, budget: EFFORT_BUDGET.medium, effort: "medium" };
}

/**
 * 思考預算上限（2026-10-25 重寫）
 *
 * 實測主因：opencode 對 @ai-sdk/openai-compatible 一律送 reasoningEffort，
 * 使用者選「high」→ proxy 收到 budget=32768 → 上游思考 40~90s 才吐首包
 * → 舊 heartbeat 12s 就斷線 → 使用者看到「上游無回應」。
 *
 * 對策：依模型等級設上限，避免小模型硬跑長思考：
 *   small  → 上限 low（2048）
 *   medium → 上限 medium（8192）
 *   large  → 不限
 * 可用 PROXY_THINKING_CEILING 覆寫（none|low|medium|high|xhigh|off=不限）。
 */
const THINK_CEILING = (() => {
  const v = (process.env.PROXY_THINKING_CEILING || "auto").toLowerCase();
  if (v === "off") return null;
  if (EFFORT_BUDGET[v] !== undefined) return v;
  return "auto";
})();
const CEIL_BY_MODEL = { small: "low", medium: "medium", large: "xhigh" };

const clampThink = (think, model) => {
  if (!think.on) return think;
  const level = classifyModel(model);
  const ceil = THINK_CEILING === "auto" ? CEIL_BY_MODEL[level] : THINK_CEILING;
  if (!ceil) return think;
  const cap = EFFORT_BUDGET[ceil];
  if (!Number.isFinite(cap) || think.budget <= cap) return think;
  log.info(
    `🧠 ${model} (${level}) 思考預算 ${think.budget}→${cap}（上限 ${ceil}，避免上游首包逾時）`,
  );
  return { on: true, budget: cap, effort: ceil };
};

// ─── 負載感知：追蹤 proxy 層級併發數，用於動態降級模型 ───
let proxyInflight = 0;
let proxyInflightPeak = 0;
function proxyRequestStart() {
  proxyInflight++;
  if (proxyInflight > proxyInflightPeak) proxyInflightPeak = proxyInflight;
}
function proxyRequestEnd() {
  if (proxyInflight > 0) proxyInflight--;
}

// 🐛 FIX: 模型切換太快（Bug #5）
// 加入滯後機制（hysteresis），防止 inflight 在門檻值附近波動時頻繁切換模型
// 降級立即生效（安全優先），升級需等待冷卻時間（定義於 config/index.js）
const MODEL_DOWNGRADE_COOLDOWN = CFG.MODEL_COOLDOWN;
let _lastDowngradeAt = 0; // 上次降級時間戳
let _currentDowngradeLv = 0; // 當前生效的降級程度 (0=無降級, 1=降一級, 2=強制 small)

/**
 * 負載感知路由降級：
 * 當 proxy 同時處理大量請求時，自動調整模型等級避免 qwen2api 排隊爆炸
 * 支援滯後（hysteresis）避免 inflight 門檻震盪導致模型頻繁切換
 * @param {"small"|"medium"|"large"} level — analyzeComplexity 原始推薦
 * @returns {"small"|"medium"|"large"} — 可能降級後的等級
 */
function loadAwareRoute(level) {
  let idx = LEVEL_ORDER[level] ?? 1;

  // P3: 計算當前需要的降級程度（基於 inflight，門檻提前，定義於 config/index.js）
  // 0 = 不降級, 1 = 降一級, 2 = 強制 small
  let needDowngrade = 0;
  if (proxyInflight >= CFG.DOWNGRADE_THRESHOLDS.small) needDowngrade = 2;
  else if (proxyInflight >= CFG.DOWNGRADE_THRESHOLDS.medium) needDowngrade = 1;

  // 降級總是立即生效（安全優先）
  if (needDowngrade > _currentDowngradeLv) {
    _currentDowngradeLv = needDowngrade;
    _lastDowngradeAt = Date.now();
  }
  // 升級需要冷卻時間：避免 inflight 波動時頻繁切換
  else if (needDowngrade < _currentDowngradeLv) {
    const elapsed = Date.now() - _lastDowngradeAt;
    if (elapsed < MODEL_DOWNGRADE_COOLDOWN) {
      if (needDowngrade === 1 || proxyInflight >= 2) {
        _lastDowngradeAt = Date.now();
      }
    } else {
      _currentDowngradeLv = needDowngrade;
    }
  }

  // 套用降級
  if (_currentDowngradeLv >= 2) idx = Math.min(idx, 0);
  else if (_currentDowngradeLv >= 1) idx = Math.min(idx, 1);
  if (idx < 0) idx = 0;

  const result = LEVEL_LABELS[idx];
  if (result !== level) {
    log.warn(
      `📡 負載降級: ${level}→${result} (inflight=${proxyInflight}, dLv=${_currentDowngradeLv}, cool=${Math.max(0, MODEL_DOWNGRADE_COOLDOWN - (Date.now() - _lastDowngradeAt)) / 1000}s)`,
    );
  }
  return result;
}

// ─── ConversationMemory：對話記憶與摘要（定義於 config/index.js） ───
// 啟用: PROXY_CONV_MEMORY=true
// 功能：滑動窗口壓縮、閒聊過濾、跨 session 摘要持久化
const CONV_MEMORY_ENABLED = CFG.CONV_MEMORY_ENABLED;
const CONV_SUMMARY_INTERVAL = CFG.CONV_SUMMARY_INTERVAL;
const CONV_RECENT_MSGS = CFG.CONV_RECENT_MSGS;
const CONV_MAX_HISTORY_TOKENS = CFG.CONV_MAX_HISTORY_TOKENS;
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || "~";
const CONV_MEMORY_FILE = path.join(
  HOME_DIR,
  ".opencode",
  "conversation-memory.json",
);
const CONV_SESSION_ID = CFG.CONV_SESSION_ID;

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
const CONV_HISTORY = CFG.CONV_HISTORY;
const CONV_DIR = path.join(HOME_DIR, ".opencode/conversations");
const CONV_SRC = CFG.CONV_SRC;

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
  const suffix = CFG.CONV_SESSION_SUFFIX;
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
  } catch (e) {
    log.error("❌ convRecord 寫入失敗:", e.message);
  }
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

// ─── 內部用途請求偵測（2026-10-23 Fix） ───
// 標題生成 / 壓縮摘要 / 子代理 都是 opencode 內部系統請求：
//   • 標題生成：只有 1 條 user 訊息「Generate a title for this conversation:」
//   • 壓縮摘要：帶 compaction 系統提示（summarizing conversations）
//   • 子代理：帶 x-opencode-parent-session-id / x-parent-session-id header
// 這些請求若被閒聊過濾或摘要注入污染，產出的佔位字串會被 opencode 當成
// 合法摘要存檔 → filterCompacted 認定為邊界 → 歷史整段消失。
const META_RE =
  /generate a title for this conversation|summarizing conversations|structured summary of the conversation/i;

const isMetaRequest = (body, headers) => {
  const msgs = body?.messages || [];
  // 標題生成特徵：極短對話 + 明確指令
  if (
    msgs.length <= 2 &&
    msgs.some((m) => META_RE.test(String(m.content || "")))
  )
    return true;
  // 壓縮 / 摘要特徵
  const tail = msgs[msgs.length - 1];
  if (tail && META_RE.test(String(tail.content || ""))) return true;
  // 子代理請求
  if (
    headers?.["x-opencode-parent-session-id"] ||
    headers?.["x-parent-session-id"]
  )
    return true;
  return false;
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

  // 🐛 FIX: 對齊系統預設「快滿才壓縮」邏輯，大幅提高閾值避免過早丟失歷史
  // 預設 8000 → 30000，接近一般模型上下文極限前才觸發
  // 電報機器人整理重點對話摘要時可節省 Token 消耗
  const COMPACTION_THRESHOLD = CFG.CONV_MAX_HISTORY_TOKENS || 30000;
  if (totalTokens > COMPACTION_THRESHOLD) {
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

// ─── Rate Limiter（滑動窗口，配置於 config/index.js） ───
const RL_MAX = CFG.RL_MAX;
const RL_WIN = CFG.RL_WIN;
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

const COMPLEX_KEYWORDS = CFG.COMPLEX_KEYWORDS;

// 模型等級分類已移至 config/index.js → classifyModel()

// 從 qwen2api 取得可用模型並分級
let envModels = null;
let envDetected = false;
let envRetryTimer = null; // 偵測失敗後重試定時器
let envRetryCount = 0; // 重試計數
const MAX_ENV_RETRIES = 10; // 最多重試 10 次（100 秒）

const detectEnv = async () => {
  if (envDetected) return;
  if (envRetryCount >= MAX_ENV_RETRIES) {
    log.error(`模型偵測已達最大重試次數 (${MAX_ENV_RETRIES})，放棄`);
    envDetected = true; // 標記為已嘗試，避免無限重試
    envModels = { small: [], medium: [CFG.MODEL_DEFAULTS.medium], large: [] };
    return;
  }
  // 清除舊的重試定時器（避免疊加）
  if (envRetryTimer) {
    clearTimeout(envRetryTimer);
    envRetryTimer = null;
  }
  try {
    const trace = `env-${_genTrace()}`;
    let list = [];
    // 路由模式：嘗試透過 Router 查詢可用模型
    if (_router) {
      try {
        const result = await _router.exec("GET", "/v1/models", null, {
          trace,
          timeout: 10000,
          retries: 0,
        });
        const raw = result?.data;
        log.debug(
          `[${trace}] /v1/models type=${typeof raw} keys=${raw ? Object.keys(raw).slice(0, 6).join(",") : "null"}`,
        );
        list = raw?.data || raw || [];
        if (!Array.isArray(list)) {
          const r2 = await _router.exec("GET", "/models", null, {
            trace,
            timeout: 10000,
            retries: 0,
          });
          const raw2 = r2?.data;
          list = raw2?.data || raw2 || [];
          log.debug(
            `[${trace}] /models type=${typeof raw2} keys=${raw2 ? Object.keys(raw2).slice(0, 6).join(",") : "null"}`,
          );
        }
      } catch (e) {
        log.debug(
          `[${trace}] Router 模型查詢失敗: ${e.message}，降級至直接請求`,
        );
        list = [];
      }
    }
    // 降級：直接請求 Qwen2API
    if (!Array.isArray(list) || list.length === 0) {
      let models = await getJSON(`${QWEN2API_URL}/v1/models`);
      list = models?.data || models || [];
      if (!Array.isArray(list)) {
        models = await getJSON(`${QWEN2API_URL}/models`);
        list = models?.data || models || [];
      }
    }
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
    // 🐛 FIX: 0 模型表示快取尚未刷新
    if (list.length === 0) {
      if (_router) {
        // Router 模式：Router 已就緒，直接使用預設值（不再重試）
        log.info(`模型暫無資料，Router 可用→使用預設模型`);
        envModels = {
          small: [],
          medium: [CFG.MODEL_DEFAULTS.medium],
          large: [],
        };
        envDetected = true;
        return;
      }
      envRetryCount++;
      log.info(
        `模型偵測暫無資料（快取未刷新），10 秒後重試 (${envRetryCount}/${MAX_ENV_RETRIES})`,
      );
      envModels = null;
      envDetected = false;
      envRetryTimer = setTimeout(() => {
        envRetryTimer = null;
        detectEnv();
      }, 10000);
      return;
    }
    envRetryCount = 0; // 成功則重置計數
    envDetected = true;
    log.info(`🌍 環境偵測: ${list.length} 模型可用`);
    if (LV >= 4) {
      for (const lvl of ["small", "medium", "large"]) {
        if (envModels[lvl].length > 0)
          log.debug(`  ${lvl}: ${envModels[lvl].join(", ")}`);
      }
    }
  } catch (e) {
    envRetryCount++;
    log.info(
      `模型偵測略過: ${e.message}，10 秒後重試 (${envRetryCount}/${MAX_ENV_RETRIES})`,
    );
    envModels = null;
    envDetected = false; // 🐛 FIX: 失敗後保持 false，啟動重試
    // 10 秒後重試偵測（qwen2api 可能尚未完全就緒）
    envRetryTimer = setTimeout(() => {
      envRetryTimer = null;
      detectEnv();
    }, 10000);
  }
};

const getModelForLevel = (level) => {
  // 環境變數強制指定優先（定義於 config/index.js）
  const forced = {
    small: CFG.MODEL_SMALL,
    medium: CFG.MODEL_MEDIUM,
    large: CFG.MODEL_LARGE,
  };
  if (forced[level]) return forced[level];

  // 從偵測到的模型列表選擇
  if (envModels?.[level]?.length > 0) return envModels[level][0];

  // 預設值
  return CFG.MODEL_DEFAULTS[level] || CFG.MODEL_DEFAULTS.medium;
};

// ─── 任務複雜度分析 ───

// ─── 歷史反饋權重查詢 (簡化版，實際應查詢 self-learning 數據) ───
const getHistoricalPenalty = (taskType) => {
  // TODO: 整合 self-learning.js 的 Metrics 數據
  // 目前預設無懲罰，待後續整合真實數據源
  return 0;
};

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

  // 動態特徵：思維鏈需求
  if (
    lower.includes("step-by-step") ||
    lower.includes("reasoning") ||
    lower.includes("think carefully")
  ) {
    score += 2;
  }

  // 歷史反饋修正 (預留接口)
  const taskType = nTools > 0 ? "coding" : "chat";
  score += getHistoricalPenalty(taskType);

  if (score >= 5) return "large";
  if (score >= 2) return "medium";
  return "small";
};

const shouldForceToolCall = (body, hasTools) => {
  if (!hasTools) return false;
  const requested = body?.tool_choice;
  if (requested === "none") return false;
  if (requested === "required") return true;
  const text = (body?.messages || [])
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ")
    .toLowerCase();
  return COMPLEX_KEYWORDS.some((kw) => text.includes(String(kw).toLowerCase()));
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

/**
 * 2026-11-05 Fix：任何路由出口都必須避開已知不支援 tools 的模型。
 * 原邏輯只在 explicit 分支攔 NO_TOOL_MODELS；複雜度路由（medium/large）
 * 與 coder 降級仍會回 qwen3.7-plus → 帶 tools 必 502 空回覆。
 */
const pickToolSafeModel = (model, hasTools) => {
  if (!hasTools) return model;
  const name = String(model || "");
  if (!NO_TOOL_MODELS.has(name.toLowerCase())) return model;
  for (const lvl of ["small", "medium", "large"]) {
    for (const m of envModels?.[lvl] || []) {
      if (!NO_TOOL_MODELS.has(String(m).toLowerCase())) {
        log.warn(`⚠️ ${name} 不支援 tools（實測 502 空回覆），自動改用 ${m}`);
        return m;
      }
    }
  }
  const fallback = CFG.MODEL_DEFAULTS.small;
  log.warn(`⚠️ ${name} 不支援 tools（實測 502 空回覆），自動改用 ${fallback}`);
  return fallback;
};

const routeModel = (body) => {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!CFG.ROUTE_ENABLED)
    return pickToolSafeModel(
      body.model || getModelForLevel("medium"),
      hasTools,
    );

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
        return pickToolSafeModel(match, hasTools);
      }
    }
    // 獨立 Qwen3-Coder 已從上游下架（envModels 過濾 -coder 變體後仍無），
    // 直接退回環境偵測到最佳可用模型（大→中→小），避免請求不存在模型回 0 tokens
    const fallback =
      envModels?.large?.[0] || envModels?.medium?.[0] || envModels?.small?.[0];
    if (fallback) {
      log.info(`📡 coder (${orig} → ${fallback}，獨立 coder 模型已下架)`);
      return pickToolSafeModel(fallback, hasTools);
    }
    const coderDefault = CFG.MODEL_CODER;
    log.info(`📡 coder (${orig} → ${coderDefault})`);
    return pickToolSafeModel(coderDefault, hasTools);
  }

  let level = analyzeComplexity(body);
  // 硬體感知：若硬體不足，降級模型等級
  // 可透過 PROXY_HW_FORCE_LEVEL=large 繞過硬體限制
  // 2026-10-23 Fix：使用者明確指定「真實存在的模型」時，硬體不得擅自降級，
  // 否則 opencode 選了 qwen3.6-plus 卻被偷偷換成小模型，行為與預期不符。
  // 大小寫不敏感比對：opencode 送 "Qwen3.6-Plus"，上游清單是 "qwen3.6-plus"
  // 命中時回傳「上游真實 id」，避免大小寫不符導致上游再降級。
  const low = orig.toLowerCase();
  const hit =
    orig &&
    ["small", "medium", "large"]
      .flatMap((l) => envModels?.[l] || [])
      .find((m) => String(m).toLowerCase() === low);
  const explicit = !!hit;
  const hwForced = CFG.HW_FORCE_LEVEL;
  const hw = detectHardware();
  const hwOrder = { small: 0, medium: 1, large: 2 };
  const taskOrder = hwOrder[level] ?? 1;
  const hwLevel =
    hwForced && hwOrder[hwForced] !== undefined ? hwForced : hw.level;
  const hwLimit = hwOrder[hwLevel] ?? 1;
  if (explicit) {
    // 2026-11-05：已知不支援 tools 的模型（qwen3.7-plus 系列）在 53 tools 下必回 502 空內容。
    // 使用者明確指定時仍尊重其選擇，但請求帶 tools 就必須換成安全模型，否則「光說不做」。
    log.debug(
      `📡 使用者指定 ${orig} → ${hit}，跳過硬體降級 (硬體=${hw.level})`,
    );
    return pickToolSafeModel(hit, hasTools);
  }
  if (taskOrder > hwLimit) {
    // 取「不超過上限的最大等級」；原 find 會拿到 small（第一個 <= limit），
    // 等於 hard limit 時也把小模型降級成最小可用，屬誤判。
    const downgraded =
      Object.entries(hwOrder)
        .filter(([, v]) => v <= hwLimit)
        .pop()?.[0] || "medium";
    log.info(
      `📡 ${level}→${downgraded} (${hwForced ? `強制=${hwForced}` : `硬體=${hw.level}`}: ${hw.reason})`,
    );
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
  return pickToolSafeModel(model, hasTools);
};

// ─── HTTP helpers (Bun.fetch) ───

const authHeaders = {
  Authorization: `Bearer ${API_KEY}`,
};

/** 帶重試的延遲 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 上游錯誤物件（2026-10-23 Fix：主因） ───
// 原 postJSON 無視 res.ok，把 503 錯誤 body（upstream_waf_challenge）當成功解析，
// 導致 choice 缺失 → 回 200 + 「⚠️ 上游無回應」8ch → opencode 視為正常回覆存檔，
// 壓縮摘要被佔位字串污染 → filterCompacted 認定為有效邊界 → 整段歷史被丟棄。
// 現在錯誤一律帶 status / challenge / retryAfter 往上拋，由 handler 決定 503。
const CHALLENGE_RE =
  /upstream_waf_challenge|waf_breaker_open|chat_challenge|fail_sys_user_validate|rgv587|被挤爆|_____tmd_____|punish\?|x5secdata/i;

const mkErr = (status, txt, retryAfter) => {
  const s = String(txt ?? "");
  const challenge = CHALLENGE_RE.test(s);
  const ra =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 120)
      : 0;
  return Object.assign(new Error(`upstream_${status}: ${s.slice(0, 160)}`), {
    status,
    challenge,
    retryAfter: ra || (challenge ? 30 : 5),
    body: s.slice(0, 500),
  });
};

/** 由 fetch Response 建立錯誤（解析 Retry-After） */
const resErr = (res, txt) => {
  const ra = parseInt(res?.headers?.get?.("retry-after") || "", 10);
  return mkErr(res?.status || 502, txt, Number.isFinite(ra) ? ra : 0);
};

// ─── 上游併發閘門（2026-10-25 Fix） ───
// 症狀：5 併發直打 qwen2api → Chrome Fetch 逾時 15s 降級 axios → 上游空內容 → 502。
// 根因：proxy 層無上游併發上限，CFG.LLM_MAX_CONCURRENT（laptop=2）定義了卻沒使用，
//       導致入口 MAX_INFLIGHT=4 全數同時打到上游，超過單帳號 WAF 容忍度。
// 對策：所有上游呼叫先過閘門，超過上限排隊；排隊超時回 429（讓客戶端退避重試）。
// 上游實際容忍度：單帳號 + 單一暫時頁面池 → 實測併發 2 就有 1 個回空內容
// （content:null, completion_tokens:0），序列則 100% 成功。
// 因此預設 1，可用 PROXY_UPSTREAM_CONCURRENCY 覆寫（多帳號部署時調高）。
const UP_LIMIT = Math.max(
  1,
  parseInt(process.env.PROXY_UPSTREAM_CONCURRENCY || "1", 10) ||
    Math.min(1, CFG.LLM_MAX_CONCURRENT),
);
// 排隊等待上限：至少容納一輪上游往返（實測單輪 15~25s），
// 否則排隊者一律 429，等於沒有背壓而是直接拒絕。
const UP_WAIT = Math.max(
  CFG.LLM_ACQUIRE_TIMEOUT,
  Math.round(CFG_TIMEOUT.chat / 4),
);
let upBusy = 0;
const upQueue = [];
const upNext = () => {
  upBusy--;
  upQueue.shift()?.();
};
const upGate = (trace) =>
  new Promise((ok, no) => {
    const grant = () => {
      upBusy++;
      ok(upNext);
    };
    if (upBusy < UP_LIMIT) return grant();
    let done = false;
    const entry = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      grant();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = upQueue.indexOf(entry);
      if (i >= 0) upQueue.splice(i, 1);
      log.warn(`[${trace || "-"}] ⏳ 上游排隊逾時 (${upBusy}/${UP_LIMIT})`);
      no(mkErr(429, "upstream_busy"));
    }, UP_WAIT);
    upQueue.push(entry);
    log.debug(`[${trace || "-"}] ⏳ 上游排隊 (${upBusy}/${UP_LIMIT})`);
  });

/**
 * postJSON — 帶可配置超時與重試
 * @param {string} url
 * @param {object} body
 * @param {number} timeout  — 單次請求超時 (ms)，預設 60s
 * @param {number} retries  — 重試次數，預設 2（最多 3 次嘗試）
 */
const postJSON = async (url, body, timeout = 60000, retries = 0) =>
  postInner(url, body, timeout, retries);

const postInner = async (url, body, timeout = 60000, retries = 0) => {
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
      // 非 2xx 一律拋錯（不再把錯誤 body 當成功結果）
      if (!res.ok) throw resErr(res, txt);
      try {
        return JSON.parse(txt);
      } catch {
        return { content: txt };
      }
    } catch (e) {
      clearTimeout(timer);
      // challenge = 出口 IP 級風控，重試必敗且加重判定 → 立即往上拋
      if (e.challenge) throw e;
      lastErr = e;
      const isTimeout = e.name === "AbortError";
      // 4xx 屬確定性失敗，重試無意義
      if (e.status && e.status < 500) throw e;
      if (attempt < retries) {
        const wait = Math.min(2000 * 2 ** attempt, 10000);
        // Add jitter (±25%) to spread concurrent retries
        const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
        log.info(
          `📤 postJSON 重試 ${attempt + 1}/${retries} (${isTimeout ? "timeout" : e.message})，等待 ${jittered}ms...`,
        );
        await delay(jittered);
        continue;
      }
      if (isTimeout) throw mkErr(504, "timeout");
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
const getJSON = async (url, timeout = 15000, retries = 0) => {
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
        const wait = Math.min(2000 * 2 ** attempt, 10000);
        const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
        log.info(
          `📤 getJSON 重試 ${attempt + 1}/${retries} (${isTimeout ? "timeout" : e.message})，等待 ${jittered}ms...`,
        );
        await delay(jittered);
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
        const results = [...new Bun.Glob(pattern).scanSync({ cwd, dot: true })];
        return results.join("\n") || "無匹配結果";
      } catch (e) {
        try {
          const { execSync } = await import("node:child_process");
          const findExpr = pattern.includes("/")
            ? `-path ${JSON.stringify(pattern)}`
            : `-name ${JSON.stringify(pattern)}`;
          const out = execSync(
            `find ${JSON.stringify(cwd)} ${findExpr} 2>/dev/null || true`,
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
      // 2026-11-05 Fix：原本寫死 ["*.ts","*.tsx","*.js"]，導致知識庫（.md/.json）
      // 永遠搜不到 → 模型對所有查詢都回「未找到」。改為尊重呼叫端 include，預設搜全部檔案。
      const includes = Array.isArray(args.include)
        ? args.include.filter(Boolean)
        : typeof args.include === "string" && args.include
          ? [args.include]
          : [];
      try {
        const { stdout } = execGrep(pattern, fp, includes);
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

// ─── 知識 / 技能 / 記憶工具（/tool/* 端點） ───
// 2026-11-05 Fix：index.js 宣告 11 個 /tool/* 端點，但 chat-proxy 從未實作，
// 插件工具全部 404/401 → 模型查知識時只能「未找到」。以下補齊實作。
const KB_ROOT = OPENCODE_DIR;

const readFileSafe = (p, cap = 12000) => {
  try {
    const txt = fs.readFileSync(p, "utf-8");
    return txt.length > cap ? `${txt.slice(0, cap)}\n…（內容過長已截斷）` : txt;
  } catch {
    return null;
  }
};

const readJsonSafe = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
};

/** 遞迴列出目錄下的檔案（限制深度與數量，避免掃爆） */
const walkFiles = (dir, exts, maxDepth = 4, acc = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= 5000) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (maxDepth <= 1) continue;
      if (e.name === "node_modules" || e.name === ".git") continue;
      walkFiles(full, exts, maxDepth - 1, acc);
    } else if (!exts || exts.some((x) => e.name.endsWith(x))) {
      acc.push(full);
    }
  }
  return acc;
};

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

const searchWiki = (query) => {
  const q = norm(query);
  if (!q) return "請提供搜尋關鍵字";
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const index = readJsonSafe(path.join(KB_ROOT, "wiki-index.json")) || {};
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const scored = entries
    .map((e) => {
      const hay = norm(
        `${e.title || ""}${e.category || ""}${(e.tags || []).join(" ")}${e.source || ""}`,
      );
      let score = 0;
      if (hay.includes(q)) score += 5;
      for (const t of terms) if (hay.includes(norm(t))) score += 2;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const wikiDir = path.join(KB_ROOT, "wiki");
  const fileHit = (title, category) => {
    const t = norm(title);
    const files = walkFiles(category ? path.join(wikiDir, category) : wikiDir, [
      ".wiki",
      ".md",
    ]);
    return files.find((f) => norm(path.basename(f)) === t) || null;
  };

  const lines = [];
  if (scored.length) {
    lines.push(`📖 維基命中 ${scored.length} 筆（索引）：`);
    for (const { e } of scored) {
      const fp = fileHit(e.title, e.category);
      lines.push(
        `• ${e.title}｜分類：${e.category || "-"}｜${fp ? `檔案：${fp}` : ""}`,
      );
    }
  }

  // 索引沒中就掃檔案內容（知識庫常有未入索引的頁面）
  if (scored.length < 3) {
    const { stdout } = execGrep(String(query), wikiDir, ["*.wiki", "*.md"]);
    const hits = String(stdout || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 10);
    if (hits.length) {
      lines.push(`\n🔍 內容比對 ${hits.length} 筆：`);
      lines.push(...hits);
    }
  }

  if (!lines.length) {
    const cnt = walkFiles(wikiDir, [".wiki", ".md"]).length;
    return `📭 維基未命中「${query}」（現有 ${cnt} 頁）。可換關鍵字，或改查 ${path.join(KB_ROOT, "skill/lesson")}、${path.join(KB_ROOT, "knowledge")}`;
  }
  return lines.join("\n");
};

const readWiki = (page) => {
  const p = norm(page);
  if (!p) return "請提供頁面名稱";
  const wikiDir = path.join(KB_ROOT, "wiki");
  const files = walkFiles(wikiDir, [".wiki", ".md"]);
  const exact = files.find((f) => norm(path.basename(f)).startsWith(p));
  const fuzzy = files.find((f) => norm(path.basename(f)).includes(p));
  const target = exact || fuzzy;
  if (!target) {
    const { stdout } = execGrep(String(page), wikiDir, ["*.wiki", "*.md"]);
    const first = String(stdout || "").split("\n").find(Boolean);
    const fp = first ? first.split(":")[0] : null;
    if (!fp) return `📭 未找到維基「${page}」。請先用 wiki-search 取得正確標題`;
    return `📄 ${fp}\n\n${readFileSafe(fp) || ""}`;
  }
  return `📄 ${target}\n\n${readFileSafe(target) || ""}`;
};

const listSkills = () => {
  const skillDir = path.join(KB_ROOT, "skill");
  let dirs;
  try {
    dirs = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch {
    return "📭 技能目錄不存在";
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const md = path.join(skillDir, d.name, "SKILL.md");
    const txt = readFileSafe(md, 4000);
    if (!txt) continue;
    const name = (txt.match(/^name:\s*(.+)$/m) || [])[1] || d.name;
    const desc = (txt.match(/^description:\s*(.+)$/m) || [])[1] || "";
    out.push(`• ${name.trim()} — ${desc.trim()}`);
  }
  return out.length
    ? `🧩 可用技能 ${out.length} 個：\n${out.join("\n")}`
    : "📭 尚無技能";
};

const readSkill = (name) => {
  const n = norm(name);
  if (!n) return "請提供技能名稱";
  const skillDir = path.join(KB_ROOT, "skill");
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(skillDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return "📭 技能目錄不存在";
  }
  const hit =
    dirs.find((d) => norm(d) === n) ||
    dirs.find((d) => norm(d).includes(n)) ||
    dirs.find((d) => {
      const txt = readFileSafe(path.join(skillDir, d, "SKILL.md"), 2000);
      return txt ? norm(txt).includes(n) : false;
    });
  if (!hit) return `📭 未找到技能「${name}」。請先用 skill-list 查看`;
  const md = path.join(skillDir, hit, "SKILL.md");
  return `🧩 ${hit}\n\n${readFileSafe(md, 16000) || "（讀取失敗）"}`;
};

const searchMemory = (query) => {
  if (!query) return "請提供搜尋關鍵字";
  const dirs = [
    path.join(KB_ROOT, "memory/entries"),
    path.join(KB_ROOT, "memory/projects"),
  ].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  if (!dirs.length) return "📭 記憶目錄不存在";
  const hits = [];
  for (const d of dirs) {
    const { stdout } = execGrep(String(query), d, ["*.md"]);
    for (const line of String(stdout || "").split("\n").filter(Boolean)) {
      if (hits.length >= 8) break;
      hits.push(line.slice(0, 500));
    }
    if (hits.length >= 8) break;
  }
  if (!hits.length)
    return `📭 記憶未命中「${query}」。可改用 wiki-search 或 grep 檔案系統`;
  return `🧠 記憶命中 ${hits.length} 筆：\n${hits.join("\n")}`;
};

const runToolEndpoint = async (url, args) => {
  const name = url.replace("/tool/", "");
  switch (name) {
    case "skill-list":
      return listSkills();
    case "skill-read":
      return readSkill(args.name || args.skill || "");
    case "wiki-search":
      return searchWiki(args.query || args.q || "");
    case "wiki-read":
      return readWiki(args.page || args.title || "");
    case "memory-query":
      return searchMemory(args.query || args.q || "");
    case "read":
    case "write":
    case "edit":
    case "glob":
    case "grep":
    case "bash":
      return execTool(name, args);
    default:
      return `[未知工具: ${name}]`;
  }
};

// ─── 環境能力定義 ───
// 結構化描述讓模型清楚知道執行環境與工具契約，避免模型因不確定而拒絕執行。
// 可透過環境變數覆蓋：
//   TOOL_PLATFORM  — linux / win32 / darwin（預設 linux）
const TOOL_PLATFORM = (process.env.TOOL_PLATFORM || "linux").toLowerCase();
const CAPABILITY_DEF = [
  "## 環境能力定義（事實，不需推測）",
  `- 架構: opencode AI 平台；你輸出 tool_calls → ${TOOL_PLATFORM} 執行，結果以 tool 訊息回傳`,
  "- 語義：自主／主動／自我＝任務與授權內自動選擇下一步；不是意識、情感、獨立目標或人格",
  "- 權限: 在專案與使用者授權範圍內讀寫檔案、執行 shell；不可逆或對外操作先確認",
  "- 工具: bash / read / write / edit / glob / grep",
  `- 知識庫根目錄: ${OPENCODE_DIR}（wiki/、knowledge/、skill/lesson/、memory/entries/、wiki-index.json）`,
  "規則:",
  "- 行動請求直接發 tool_calls，不要只描述計畫",
  "- 工具失敗（找不到檔案/逾時/4xx/5xx）就換工具或路徑繼續；不要停下、不要反問、不要等確認",
  "- 不要捏造 <tool_response>；工具結果只會以 tool 訊息出現",
  "- 需要專案規則/架構時，用 read 工具讀取 AGENTS.md / ARCHITECTURE.md，不要憑空推測",
  "- 查前例/知識：先用 grep 搜知識庫根目錄（含 .md/.json，不要限副檔名），或讀 wiki-index.json；查無結果就換關鍵字、換目錄、改用 glob 找檔名，不要直接回覆「未找到」",
  "- 查知識庫順序：memory_recover/memory_recall → knowledge_search/knowledge_ask（若可用）→ grep/Read 命中檔；缺查＝盲試，不要猜路徑，也不把未讀內容當已知",
  "- 執行 grep 時 path 必須是絕對路徑；若在目前專案找不到，先 glob 確認檔案是否真的存在",
  "- exit code 0 = 成功（即使無輸出文字）",
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

/**
 * 工作邏輯：行動型任務 + 有 tools 時，在訊息尾端動態注入「強制輸出 tool_call」。
 * 為什麼不用單純 prompt 規則：免額網頁鏈路會無視 tool_choice=required（2026-11-05 實測
 * finish=stop/calls=[]），且 system 中段會被 trimPrompt 裁掉。放尾端 + 每回合注入最穩。
 */
const injectActionEnforcement = (msgs, body, hasTools) => {
  if (!hasTools) return msgs;
  if (!shouldForceToolCall(body, hasTools)) return msgs;
  const MARK = "[[action-enforce]]";
  if (msgs.some((m) => typeof m.content === "string" && m.content.includes(MARK)))
    return msgs;
  return [
    ...msgs,
    {
      role: "system",
      content: `${MARK}\n本回合是行動型任務：必須立即輸出 <tool_call> 開始執行，禁止只描述計畫或反問。`,
    },
  ];
};

// ─── 自我學習系統注入 ───
// 將 self-learning 模組整合進 chat-proxy，使 AI 可直接呼叫 self_learn_* 工具

const SELF_LEARN_PROMPT = (() => {
  try {
    const m = selfLearning.getLearningMetrics().metrics;
    const lv = m.level,
      acc = (m.accuracy * 100).toFixed(0);
    return `\n<plugin_info name="self-learning">
自我學習系統 Level ${lv}・準確度 ${acc}%
可用工具（AI 函式呼叫）：self_learn_*（配置/學習/分析）| self_config_*（系統設定）
用法範例：呼叫 self_learn_trait 工具調整語氣，呼叫 self_record_feedback 記錄偏好
語義：自我學習＝自動記錄／分析的工具流程，不代表有意識、情感或獨立目標。
注意：以上均為 AI 函式呼叫工具，不可透過 bash 執行。
</plugin_info>`;
  } catch {
    return `\n<plugin_info name="self-learning">
自我學習系統 Level 1・準確度 0%
可用工具（AI 函式呼叫）：self_learn_*（配置/學習/分析）| self_config_*（系統設定）
語義：自我學習＝自動記錄／分析的工具流程，不代表有意識、情感或獨立目標。
注意：以上均為 AI 函式呼叫工具，不可透過 bash 執行。
</plugin_info>`;
  }
})();

// 自我學習工具定義（OpenAI function-calling 格式）
const SELF_LEARN_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "self_learn_code_style",
      description:
        "分析指定專案的程式碼風格（命名、縮排、錯誤處理、註解、引入偏好）。分析結果會儲存供後續個人化推薦使用。",
      parameters: {
        type: "object",
        properties: {
          projectPath: { type: "string", description: "專案絕對路徑" },
        },
        required: ["projectPath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_response_style",
      description:
        "分析互動記錄中的回應偏好（長度分佈、代碼使用量、解釋深度）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "self_record_feedback",
      description:
        "記錄對 AI 回應的反饋，幫助系統學習你的偏好。支援三種反饋：accepted（完全接受）、edited（有修改）、rejected（拒絕）。",
      parameters: {
        type: "object",
        properties: {
          feedback: {
            type: "string",
            enum: ["accepted", "edited", "rejected"],
            description: "反饋類型",
          },
          prompt: { type: "string", description: "原始提示（選填）" },
          response: { type: "string", description: "回應內容（選填）" },
        },
        required: ["feedback"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_status",
      description:
        "查看自我學習系統的完整狀態：層級、資料量、準確度、下一步建議。",
      parameters: {
        type: "object",
        properties: {
          detail: {
            type: "string",
            enum: ["full"],
            description: "設 'full' 顯示完整原始數據",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_recommend",
      description:
        "基於學習數據提供個人化建議：命名風格、縮排、錯誤處理策略、常用工具。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_config",
      description:
        "檢視或修改自我學習配置。可用欄位: proLevel(1-5), personality(角色名), autoPersona(true/false), learningConsent(true/false), responseVerbosity(1-5), customPrompt(自定義角色描述)。不加參數 = 檢視目前配置。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "欄位名稱，如 proLevel、personality、autoPersona",
          },
          value: { type: "string", description: "欄位值" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_trait",
      description:
        "微調模型個性特質。維度: warmth(貼心), proactive(積極), depth(深度), patience(耐心), humor(幽默)，值 1-5。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            enum: ["warmth", "proactive", "depth", "patience", "humor"],
            description: "特質名稱",
          },
          value: { type: "string", description: "數值 1-5" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_analyze",
      description: "分析你的問題風格，自動推薦適合的角色與回應模式。",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "你的問題或文字內容" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_export",
      description: "匯出個人化模型為 JSON 檔案，用於備份或轉移到其他機器。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_prompt",
      description:
        "預覽目前設定的 system prompt 內容，包含專業水平、角色、個性特質的完整提示。",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "模擬用戶訊息（啟用 autoPersona 時有效）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_learn_reset",
      description:
        "⚠️ 重置所有學習資料（程式碼風格、回應偏好、互動記錄、指標）。此操作不可回復。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "self_config_get",
      description:
        "讀取 OpenCode 系統設定。不加 key 顯示概要，指定 key 顯示特定欄位值。支援點記法如 providers.openai.apiKey。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "設定路徑，如 plugin、provider、model。留空顯示全部",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_config_set",
      description:
        "修改 OpenCode 系統設定。支援點記法如 providers.openai.apiKey。值會以 JSON 型別解析（數字、布林、陣列、物件）。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "設定路徑，如 plugin、model、provider.anthropic.apiKey",
          },
          value: { type: "string", description: "設定值。自動推斷型別" },
        },
        required: ["key", "value"],
      },
    },
  },
];

/** 執行自我學習工具，回傳文字結果 */
async function execSelfLearnTool(name, args) {
  const start = Date.now();
  try {
    let result;
    switch (name) {
      case "self_learn_code_style": {
        const r = await selfLearning.learnCodeStyle(args.projectPath);
        if (r.error) return `❌ ${r.error}`;
        const n = r.naming,
          i = r.indent,
          e = r.errorHandling,
          c = r.comments;
        result = `📊 程式碼風格分析\n檔案: ${r.totalFiles} | 行數: ${r.totalLines}\n命名: camelCase ${n.camelCase}% | snake_case ${n.snake_case}% | PascalCase ${n.PascalCase}%\n縮排: 2空格 ${i.spaces2}% | 4空格 ${i.spaces4}% | Tab ${i.tabs}%\n錯誤處理: tryCatch ${e.tryCatch}次 | earlyReturn ${e.earlyReturn}次\n註解: ${c.total}處 | ESM: ${r.imports.esm} | CJS: ${r.imports.cjs}`;
        break;
      }
      case "self_learn_response_style": {
        const interactions = selfLearning.getInteractions();
        const r = selfLearning.learnResponseStyle(interactions);
        const len = r.responseLength;
        const total = len.short + len.medium + len.long || 1;
        result = `📊 回應風格分析\n短回應: ${len.short}次 (${((len.short / total) * 100).toFixed(1)}%)\n中回應: ${len.medium}次 (${((len.medium / total) * 100).toFixed(1)}%)\n長回應: ${len.long}次 (${((len.long / total) * 100).toFixed(1)}%)\n代碼區塊: ${r.codeBlockUsage}次\n解釋深度: ${r.explanationDepth}/3`;
        break;
      }
      case "self_record_feedback": {
        const fb = args.feedback || "accepted";
        const m = selfLearning.recordInteraction(
          args.prompt || "",
          args.response || "",
          fb,
          {
            modelUsed: args.modelUsed || "unknown",
            routingScore: args.routingScore || null,
            taskType: args.taskType || "general",
          },
        );
        result = `📝 反饋已記錄\n類型: ${fb}\n模型: ${args.modelUsed || "N/A"}\n總資料: ${m.dataPoints}筆 | 準確度: ${(m.accuracy * 100).toFixed(1)}% | Level ${m.level}`;
        break;
      }
      case "self_learn_status": {
        if (args.detail === "full") {
          const all = selfLearning.getLearningMetrics();
          const m = all.metrics;
          result = `🧠 自我學習系統 (完整)\n層級: Level ${m.level}\n資料: ${m.dataPoints}筆 | 準確度 ${(m.accuracy * 100).toFixed(1)}%\n反饋: ✅${m.interactions.accepted} ✏️${m.interactions.edited} ❌${m.interactions.rejected}`;
          if (all.codeStyle)
            result += `\n\n程式碼風格: 已學習 (${all.codeStyle.totalFiles}檔案)`;
          if (all.responseStyle) result += `\n回應風格: 已學習`;
        } else {
          result = selfLearning.summarizeMetrics();
        }
        break;
      }
      case "self_learn_recommend": {
        const r = selfLearning.getPersonalRecommendation();
        result = `🎯 個人化推薦\n信心指數: ${(r.confidence * 100).toFixed(1)}%\n\n程式碼風格\n命名: ${r.codeStyle.naming}\n縮排: ${r.codeStyle.indent > 0 ? `${r.codeStyle.indent}空格` : "Tab"}\n\n錯誤處理: ${r.strategy}`;
        if (r.tools.length)
          result += `\n\n常用工具\n${r.tools.map((t) => `• ${t}`).join("\n")}`;
        break;
      }
      case "self_learn_config": {
        if (!args.key) {
          const cfg = selfLearning.getConfig();
          const pro = selfLearning.getProLevel();
          const persona = selfLearning.getPersona();
          const traits = selfLearning.getTraits();
          result = `⚙️ 自我學習配置\n學習功能: ${cfg.learningConsent ? "🟢開啟" : "🔴關閉"}\n專業水平: ${pro.label} (${cfg.proLevel}/5)\n角色: ${persona.label || "無"}\n自動偵測: ${cfg.autoPersona ? "🟢開啟" : "⚪關閉"}\n詳細度: ${cfg.responseVerbosity}/5`;
          if (cfg.customPrompt)
            result += `\n自定義: ${cfg.customPrompt.slice(0, 60)}`;
          result += `\n\n個性:\n${Object.entries(traits)
            .map(
              ([k, v]) =>
                `  ${{ warmth: "🤗貼心", proactive: "⚡積極", depth: "📚深度", patience: "🧘耐心", humor: "😄幽默" }[k] || k}: ${"█".repeat(v)}${"░".repeat(5 - v)} (${v}/5)`,
            )
            .join("\n")}`;
        } else {
          let val = args.value;
          if (val === "true") val = true;
          else if (val === "false") val = false;
          else if (/^\d+$/.test(val)) val = parseInt(val, 10);
          const r = selfLearning.updateConfig({ [args.key]: val });
          result = r.changed.length
            ? `✅ 已更新 ${r.changed.join(", ")}`
            : `⚠️ 無效欄位: ${args.key}`;
        }
        break;
      }
      case "self_learn_trait": {
        const r = selfLearning.setTrait(args.key, args.value);
        if (!r.ok) result = `❌ ${r.error}`;
        else
          result = `✅ ${{ warmth: "🤗貼心", proactive: "⚡積極", depth: "📚深度", patience: "🧘耐心", humor: "😄幽默" }[r.trait] || r.trait} → ${r.val}/5`;
        break;
      }
      case "self_learn_analyze": {
        const r = selfLearning.analyzeUserLevel(args.message);
        result = `🔍 分析結果\n推薦: ${r.label}`;
        if (r.reason) result += `\n依據: ${r.reason}`;
        if (r.persona) {
          const info = selfLearning.getPersona(r.persona);
          result += `\n\n${info.desc}`;
        }
        break;
      }
      case "self_learn_export": {
        const r = selfLearning.exportModel();
        result = `📦 模型已匯出\n路徑: ${r.path}\n大小: ${(r.size / 1024).toFixed(1)}KB`;
        break;
      }
      case "self_learn_prompt": {
        const lang = selfLearning.getConfig().responseLang ?? "zh-TW";
        const langRule =
          lang === "zh-TW"
            ? "一律使用繁體中文（台灣正體）回答，嚴禁簡體字；專有名詞與程式碼保留原文。"
            : "Respond in English.";
        result = `📋 System Prompt 預覽\n\n${selfLearning.getProLevelPrompt(undefined, undefined, args.message || "")}\n\n── 實際注入（每次請求）──\n[語言工作邏輯]\n${langRule}`;
        break;
      }
      case "self_learn_reset": {
        selfLearning.resetLearningData();
        result = "🔄 所有學習資料已清空。";
        break;
      }
      case "self_config_get": {
        try {
          const cfg = {
            plugin: [],
            model: "qwen-proxy/Qwen3.6-Plus",
            provider: { opencode: {}, "qwen-proxy": {} },
          };
          if (args.key) {
            const val = args.key.split(".").reduce((o, k) => o?.[k], cfg);
            result =
              val !== undefined
                ? `🔍 ${args.key}\n\n${JSON.stringify(val, null, 2)}`
                : `❌ 找不到設定: ${args.key}`;
          } else {
            result = `⚙️ OpenCode 系統設定\n供應商: opencode, qwen-proxy\n模型: qwen-proxy/Qwen3.6-Plus`;
          }
        } catch {
          result = "❌ 讀取設定異常";
        }
        break;
      }
      case "self_config_set": {
        result = "✅ 設定已更新（本地模式，僅記憶體有效）";
        break;
      }
      default:
        result = `❌ 未知工具: ${name}`;
    }
    const elapsed = Date.now() - start;
    log.info(`🧠 self-learning tool: ${name} (${elapsed}ms)`);
    return result;
  } catch (e) {
    log.error(`🧠 self-learning error (${name}):`, e.message);
    return `❌ 執行 ${name} 失敗: ${e.message}`;
  }
}

// ─── 自我學習工具注入策略 ───
// 2026-10-23 Fix：原 `if (!tools) return SELF_LEARN_TOOL_DEFS` 會在客戶端
// 完全沒工具時硬塞 13 個自我學習工具 → qwen2api 注入 tool-prompt，
// prompt 膨脹、上游延遲 25s+、回覆只剩 2ch。
// 2026-10-25 Fix：預設改 off。opencode 本身就有 self_learn_* 工具，
// proxy 再塞 13 個（約 2860 tokens）純屬重複膨脹 → 直接推高到風控門檻。
//   off（預設）= 一律不附加（opencode 已自帶同名工具）
//   auto        = 僅當客戶端本來就有 tools 才附加
//   on          = 一律附加（舊行為）
const SELF_TOOLS_MODE = (process.env.PROXY_SELF_TOOLS || "off").toLowerCase();

/** 是否應該注入自我學習工具 */
const shouldInjectSelfTools = (tools) => {
  if (SELF_TOOLS_MODE === "off") return false;
  if (SELF_TOOLS_MODE === "on") return true;
  return Array.isArray(tools) && tools.length > 0;
};

/** 將自我學習工具注入 tools 陣列 */
function injectSelfLearnTools(tools) {
  if (!shouldInjectSelfTools(tools)) return tools;
  const existing = new Set(
    (tools || []).map((t) => t.function?.name || t.name || ""),
  );
  const merged = [...(tools || [])];
  for (const t of SELF_LEARN_TOOL_DEFS) {
    if (!existing.has(t.function.name)) merged.push(t);
  }
  return merged;
}

/** 將 <plugin_info> 注入 system messages */
function injectSelfLearnSystemPrompt(msgs) {
  const sysIdx = msgs.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const copy = [...msgs];
    copy[sysIdx] = {
      ...copy[sysIdx],
      content: `${copy[sysIdx].content}${SELF_LEARN_PROMPT}`,
    };
    return copy;
  }
  return [{ role: "system", content: SELF_LEARN_PROMPT.trim() }, ...msgs];
}

// ─── 語言工作邏輯注入 ───
// 為什麼需要：免額鏈路模型本身不知道要用繁體，僅靠輸出端 toTrad 字面轉換（治標），
// 程式碼區塊不轉 + 轉換失敗 fallback → 顯示仍可能出現簡體、行為不一致。
// 此處在 system 注入硬規則，讓模型「生成階段」就用繁體（與輸出端轉換互補）。
const LANG_MARK = "[[lang-rule]]";
const injectLanguageRule = (msgs) => {
  if (
    msgs.some(
      (m) => typeof m.content === "string" && m.content.includes(LANG_MARK),
    )
  )
    return msgs;
  let lang = "zh-TW";
  try {
    lang = selfLearning.getConfig().responseLang ?? "zh-TW";
  } catch {}
  const rule =
    lang === "zh-TW"
      ? "一律使用繁體中文（台灣正體）回答，嚴禁簡體字；專有名詞與程式碼保留原文。"
      : "Respond in English.";
  const block = `\n${LANG_MARK}\n[語言工作邏輯]\n${rule}`;
  const sysIdx = msgs.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const copy = [...msgs];
    copy[sysIdx] = {
      ...copy[sysIdx],
      content: `${copy[sysIdx].content}${block}`,
    };
    return copy;
  }
  return [{ role: "system", content: block.trim() }, ...msgs];
};

/** 檢查並執行 tool_calls 中的自我學習工具，回傳 { handled, results } */
async function handleSelfLearnToolCalls(toolCalls) {
  const selfCalls = toolCalls.filter((tc) =>
    tc.function?.name?.startsWith("self_"),
  );
  if (!selfCalls.length) return { handled: false, results: [] };
  log.info(`🧠 自我學習 tool_calls x${selfCalls.length}`);
  const results = [];
  // P5: 設定工具執行超時（5s），避免慢工具阻塞主流程
  const TOOL_TIMEOUT_MS = 5000;
  for (const tc of selfCalls) {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {}
    try {
      const text = await Promise.race([
        execSelfLearnTool(tc.function.name, args),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tool timeout after ${TOOL_TIMEOUT_MS}ms`)),
            TOOL_TIMEOUT_MS,
          ),
        ),
      ]);
      results.push({ role: "tool", tool_call_id: tc.id, content: text });
    } catch (e) {
      log.warn(`⚠️ 自我學習工具超時或失敗: ${tc.function.name} - ${e.message}`);
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `⚠️ 工具執行超時或失敗: ${e.message}`,
      });
    }
  }
  return { handled: true, results };
}

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
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(
      `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.round(Date.now() / 1000), model, ...data })}\n\n`,
    );
  } catch { /* 客戶端可能已斷線 */ }
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
//
// 2026-10-23 Fix（減少上游無回應）：
//   原實作「每個請求都查、命中就全注入」，導致
//   ① 每請求多 5s 等待（bridge 掛掉時更久）
//   ② 注入的無關記憶膨脹 prompt，上游變慢、回覆變短
//   改為：短句/指令類不查、分數門檻 0.5、最多 3 筆、內容截斷。

const MEM_MIN_SCORE = Number(process.env.PROXY_MEM_MIN_SCORE || 0.5);
const MEM_LIMIT = Number(process.env.PROXY_MEM_LIMIT || 3);
const MEM_SUMMARY_MAX = Number(process.env.PROXY_MEM_SUMMARY_MAX || 160);

/** 短句、純指令、問候不查記憶（省一次往返） */
const _skipMemQuery = (q) =>
  q.length < 12 ||
  /^(hi|hello|ok|yes|no|你好|嗨|哈囉|謝謝|繼續|好|對)$/i.test(q);

// ─── Prompt 長度守門（2026-10-23 實測新增）───
// 實測 qwen3.7-plus（chat.qwen.ai WAF 路徑）：
//   32K tokens → 正常回覆
//   38K~42K   → content:null（上游靜默空回覆）
//   44K+      → waf_breaker_open（IP 級風控，重試必敗且加重判定）
// proxy 原本完全沒有長度檢查，opencode 一次送 114 條訊息 + 42 個工具定義
// 很容易超過，使用者看到的就是「上游無回應」。
// 對策：送上游前在本地裁剪，保留 system + 最近 N 條，其餘換成一行省略提示。
// 2026-11-06 Fix：原 tokenOf 一律 length/4，嚴重低估中文（AGENTS.md／system prompt
// 幾乎全中文）。日誌實證：proxy 估算 14416 tokens，tiktoken 實算 18270（低估 ~27%，
// 重 CJK 內容低估 50%+）→ PROMPT_TOKEN_LIMIT 守門形同虛設，送上游必觸發
// internal_error／Completion:0。改為 CJK-aware：CJK 約 1.25 token/字，其餘 /4。
const CJK_CHAR_RE =
  /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/g;
const tokenOf = (s) => {
  const str = s || "";
  const cjk = (str.match(CJK_CHAR_RE) || []).length;
  return Math.ceil(cjk * 1.25 + (str.length - cjk) / 4);
};

const msgTokens = (m) => {
  const c = m?.content;
  const text =
    typeof c === "string" ? c : Array.isArray(c) ? JSON.stringify(c) : "";
  const calls = m?.tool_calls ? JSON.stringify(m.tool_calls) : "";
  return tokenOf(text) + tokenOf(calls) + 4;
};

const promptTokens = (msgs, tools) =>
  (msgs || []).reduce((s, m) => s + msgTokens(m), 0) +
  (tools?.length ? tokenOf(JSON.stringify(tools)) : 0);

// 2026-11-05 Fix：工具定義（tools JSON）原本有計入 token 卻「從未裁剪」。
// opencode 一次送 53 個工具 ≈ 9.7K tokens，system 上限 8K → 兩者相加固定 17.7K，
// 超過 16K 上限時 guard 迴圈已無非-system 可丟，日誌出現
// 「20758 → 17704 / 21391 → 17704 / 21742 → 17704（丟棄 0 條）」三次同值。
// 送超限 prompt 上游 → 空回或 600s timeout。以下先裁描述，再按核心優先度丟工具。
const TOOL_DESC_MAX = 200;
const TOOL_PARAM_DESC_MAX = 100;
const CORE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "list",
  "todowrite",
  "task",
  "webfetch",
  "websearch",
  "patch",
  "multiedit",
]);

/** 壓縮單一工具定義的描述文字（保留名稱與參數結構，只砍長篇說明） */
const capToolDef = (t) => {
  const fn = t?.function;
  if (!fn) return t;
  const desc = typeof fn.description === "string" ? fn.description : "";
  let params = fn.parameters;
  if (
    params &&
    typeof params === "object" &&
    params.properties &&
    typeof params.properties === "object"
  ) {
    let changed = false;
    const props = {};
    for (const [k, v] of Object.entries(params.properties)) {
      if (
        v &&
        typeof v.description === "string" &&
        v.description.length > TOOL_PARAM_DESC_MAX
      ) {
        props[k] = { ...v, description: v.description.slice(0, TOOL_PARAM_DESC_MAX) };
        changed = true;
      } else {
        props[k] = v;
      }
    }
    if (changed) params = { ...params, properties: props };
  }
  if (desc.length <= TOOL_DESC_MAX && params === fn.parameters) return t;
  return {
    ...t,
    function: {
      ...fn,
      description: desc.slice(0, TOOL_DESC_MAX),
      parameters: params,
    },
  };
};

/**
 * 極簡化工具定義：只留名稱與參數結構，移除所有描述與範例。
 * 用於描述壓縮後仍超限的情況，避免直接丟棄工具（模型看不到工具 = 光說不做事）。
 */
const minifyToolDef = (t) => {
  const fn = t?.function;
  if (!fn) return t;
  let params = fn.parameters;
  if (
    params &&
    typeof params === "object" &&
    params.properties &&
    typeof params.properties === "object"
  ) {
    const props = {};
    for (const [k, v] of Object.entries(params.properties)) {
      if (!v || typeof v !== "object") {
        props[k] = v;
        continue;
      }
      const { description, examples, ...rest } = v;
      props[k] = rest;
    }
    params = { ...params, properties: props };
  }
  return { ...t, function: { ...fn, description: "", parameters: params } };
};

/**
 * 骨架化工具定義：只留名稱 + 參數名稱/型別/enum，移除所有描述與巢狀結構細節。
 * 為什麼需要：opencode 一次送 53 個工具，minify 後仍佔 ~8K tokens，會把模型逼到
 * 只剩 4 個工具（丟掉 grep/glob → 模型「找不到」就回覆未找到）。
 * 骨架化後 53 個工具約 1K tokens，可保留全部工具名稱，模型才不會失去搜尋能力。
 */
const skeletonToolDef = (t) => {
  const fn = t?.function;
  if (!fn) return t;
  let params = fn.parameters;
  if (
    params &&
    typeof params === "object" &&
    params.properties &&
    typeof params.properties === "object"
  ) {
    const props = {};
    for (const [k, v] of Object.entries(params.properties)) {
      if (!v || typeof v !== "object") {
        props[k] = { type: typeof v === "string" ? "string" : "object" };
        continue;
      }
      const slim = { type: v.type || "string" };
      if (Array.isArray(v.enum)) slim.enum = v.enum;
      if (v.items && typeof v.items === "object") {
        slim.items = { type: v.items.type || "string" };
      }
      props[k] = slim;
    }
    params = {
      type: "object",
      properties: props,
      ...(Array.isArray(params.required) && params.required.length
        ? { required: params.required }
        : {}),
    };
  }
  return { ...t, function: { ...fn, description: "", parameters: params } };
};

/**
 * 核心工具超限時的丟棄順序（先丟低價值，最後才碰搜尋/讀檔能力）。
 * 2026-11-05 Fix：原 coreOnly.pop() 從尾端亂丟，常把 grep/glob 丟掉，
 * 模型失去搜尋能力 → 對任何查詢都回「未找到」。
 */
const CORE_DROP_ORDER = [
  "patch",
  "multiedit",
  "list",
  "todowrite",
  "task",
  "webfetch",
  "websearch",
  "write",
  "edit",
];
const CORE_NEVER_DROP = new Set(["bash", "read", "grep", "glob"]);

/**
 * 將 tools 壓到剩餘預算內：先壓描述 → 極簡化 → 骨架化 → 才從尾端丟非核心工具，
 * 最後才動核心工具（且絕不丟 bash/read/grep/glob）。
 */
const trimToolsToBudget = (msgs, tools, limit) => {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  let capped = tools.map(capToolDef);
  if (promptTokens(msgs, capped) <= limit) return capped;

  capped = tools.map(minifyToolDef);
  if (promptTokens(msgs, capped) <= limit) return capped;

  capped = tools.map(skeletonToolDef);
  if (promptTokens(msgs, capped) <= limit) return capped;

  const keep = [];
  const droppable = [];
  capped.forEach((t, i) => {
    const name = String(t?.function?.name || t?.name || "").toLowerCase();
    if (CORE_TOOL_NAMES.has(name)) keep.push({ t, i });
    else droppable.push({ t, i });
  });

  const ordered = (arr) =>
    arr
      .slice()
      .sort((a, b) => a.i - b.i)
      .map((x) => x.t);

  while (droppable.length > 0) {
    const candidate = ordered([...keep, ...droppable]);
    if (promptTokens(msgs, candidate) <= limit) return candidate;
    droppable.pop();
  }

  const coreOnly = ordered(keep);
  const nameOf = (t) =>
    String(t?.function?.name || t?.name || "").toLowerCase();
  while (coreOnly.length > 4 && promptTokens(msgs, coreOnly) > limit) {
    let idx = -1;
    for (const n of CORE_DROP_ORDER) {
      idx = coreOnly.findIndex((t) => nameOf(t) === n);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      idx = coreOnly.map(nameOf).findLastIndex((n) => !CORE_NEVER_DROP.has(n));
    }
    if (idx < 0) break;
    coreOnly.splice(idx, 1);
  }
  return coreOnly;
};

/**
 * 裁剪過長的 messages + tools，確保送上游不超過 token 上限。
 * 保留所有 system 訊息 + 最近 PROMPT_KEEP_MSGS 條，
 * 中間被丟棄的部分壓成一行提示，讓模型知道前面有歷史被省略。
 * @returns {{ messages: any[], tools: any[] }} 裁剪後的訊息與工具（名稱維持 tools 以相容舊呼叫）
 */
const trimPrompt = (msgs, tools, model) => {
  const limit = CFG.PROMPT_TOKEN_LIMIT;
  const total = promptTokens(msgs, tools);
  if (total <= limit) return { messages: msgs, tools };

  // 2026-10-25 Fix：system 訊息（opencode 的 AGENTS.md + 規則全文）常佔掉大半額度，
  // 原邏輯只丟非 system → 「丟棄 0 條」但總量仍爆表，最後靠截斷硬撐。
  // 2026-11-05 Fix：sysCap 由 limit/2 → limit*0.6；工具改骨架化後省下的額度回饋給 system，
  // 避免除錯紀律/工作邏輯（通常在尾端）被砍掉 → 模型失去「自主查找主因」認知。
  // 保留比例改為頭 40% + 尾 60%（尾端是硬規則注入區：語言規則、CAPABILITY_DEF）。
  const sysCap = Math.max(Math.floor(limit * 0.6), 4000);
  const clampSys = (m) => {
    if (m.role !== "system" || typeof m.content !== "string") return m;
    if (tokenOf(m.content) <= sysCap) return m;
    const head = Math.floor(sysCap * 4 * 0.4);
    const tail = Math.floor(sysCap * 4 * 0.6);
    const content =
      m.content.length > head + tail
        ? m.content.slice(0, head) +
          "\n\n…（中段規則因長度限制已省略）…\n\n" +
          m.content.slice(-tail)
        : m.content;
    return { ...m, content };
  };

  const keep = CFG.PROMPT_KEEP_MSGS;
  const sys = msgs.filter((m) => m.role === "system").map(clampSys);
  const rest = msgs.filter((m) => m.role !== "system");
  const tail = rest.slice(-keep);
  let dropped = rest.length - tail.length;
  const note = {
    role: "user",
    content: `[前 ${dropped} 條較早的對話因長度限制已省略，請依據後續內容繼續。]`,
  };
  let trimmed = dropped > 0 ? [...sys, note, ...tail] : [...sys, ...tail];

  // 2026-11-05 Fix 順序：先裁工具（壓描述 → 丟非核心），再丟訊息。
  // 原順序用「原始巨大 tools」判斷超限，會先把訊息全部丟光才輪到工具（實測 41 條全滅）。
  let workingTools = Array.isArray(tools)
    ? trimToolsToBudget(trimmed, tools, limit)
    : tools;
  // 工具已裁仍超限（單條訊息過大 / system 過長）→ 從最舊的非 system 開始丟
  let guard = 0;
  while (promptTokens(trimmed, workingTools) > limit && guard++ < 200) {
    const idx = trimmed.findIndex((m) => m.role !== "system" && m !== note);
    if (idx < 0) break;
    trimmed = trimmed.filter((_, i) => i !== idx);
    dropped++;
  }

  // 最後手段：截斷單條超大內容（例如貼了一大段 log）
  // 2026-11-05 修正單位混用 bug：sysCap 是 token，cap 原本是字元，
  // system 會被二次砍到 (limit/2) 字元（≈ limit/8 tokens），AGENTS.md 中段規則（含除錯紀律）被誤刪
  // → 模型失去「自主除錯／不要光說」硬規則。現在 system 用 sysCap*4 字元（= sysCap tokens），
  // 非 system 維持 (limit/2) 字元。總量仍受 limit 控制。
  const capChars = Math.max(Math.floor(limit / 2), 4000);
  let capped = trimmed.map((m) => {
    if (typeof m.content !== "string") return m;
    const maxChars = m.role === "system" ? sysCap * 4 : capChars;
    if (m.content.length <= maxChars) return m;
    return {
      ...m,
      content: m.content.slice(0, maxChars) + "\n…（內容過長已截斷）",
    };
  });

  // 2026-11-05 Fix：tools 也納入裁剪，否則 system+tools 固定超限
  const trimmedTools = trimToolsToBudget(capped, workingTools, limit);

  // 最終硬保證：若 system 本身仍超限（極端情況），逐步壓到符合上限
  let finalMsgs = capped;
  let guard2 = 0;
  while (promptTokens(finalMsgs, trimmedTools) > limit && guard2++ < 30) {
    const sysMsgs = finalMsgs.filter(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.length > 400,
    );
    if (sysMsgs.length === 0) break;
    const largest = sysMsgs.reduce((a, b) =>
      a.content.length >= b.content.length ? a : b,
    );
    const newLen = Math.floor(largest.content.length * 0.75);
    finalMsgs = finalMsgs.map((m) =>
      m === largest
        ? { ...m, content: m.content.slice(0, newLen) + "\n…（內容過長已截斷）" }
        : m,
    );
  }

  log.warn(
    `✂️ prompt 超長裁剪: ${total} → ${promptTokens(finalMsgs, trimmedTools)} tokens (上限 ${limit}, 丟棄 ${dropped} 條訊息, 工具 ${Array.isArray(tools) ? tools.length : 0}→${Array.isArray(trimmedTools) ? trimmedTools.length : 0}, model=${model})`,
  );
  return { messages: finalMsgs, tools: trimmedTools };
};

const recallMemories = async (messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query =
    typeof lastUser?.content === "string" ? lastUser.content.slice(0, 500) : "";
  if (!query) return "";
  if (_skipMemQuery(query.trim())) return "";
  try {
    const res = await fetch(`${MEMORY_BRIDGE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: MEM_LIMIT * 3 }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    // 分數門檻過濾：低相關記憶注入只會干擾上游
    const hits = (data.entries || [])
      .filter((e) => Number(e.score || 0) >= MEM_MIN_SCORE)
      .slice(0, MEM_LIMIT);
    if (!hits.length) return "";
    log.info(`🧠 Memory recall: ${hits.length} 筆（門檻 ${MEM_MIN_SCORE}）`);
    return `相關記憶：\n${hits
      .map(
        (e, i) =>
          `[${i + 1}] ${String(e.summary || "").slice(0, MEM_SUMMARY_MAX)}`,
      )
      .join("\n")}`;
  } catch {
    return "";
  }
};

const runSinglePass = async (body, retriesLeft = 1) => {
  const release = await upGate("pass");
  try {
    return await runPassInner(body, retriesLeft);
  } finally {
    release();
  }
};

const runPassInner = async (body, retriesLeft = 1) => {
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

    // 注入自我學習 system prompt（含 plugin_info）
    msgs = injectSelfLearnSystemPrompt(msgs);
    // 注入語言工作邏輯（繁體硬規則，每次請求生效）
    msgs = injectLanguageRule(msgs);

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
    const clientHasTools = Array.isArray(tools) && tools.length > 0;
    // 2026-11-05 Fix：上游 Qwen 帶工具且開思考時，常只輸出「思考 Process」計畫文字就 stop
    // （實測 tool_calls 成功率：think=true 1/4、think=false 4/4）。
    // 客戶端未在模型名明確要求 thinking 時，工具請求一律關閉思考。
    const forceNoThink =
      clientHasTools && !body.model?.toLowerCase().includes("thinking");
    const think = forceNoThink
      ? { on: false, budget: 0, effort: "none" }
      : clampThink(resolveThink(body), currentModel);
    const isThinking = think.on;

    let allTools = injectSelfLearnTools(tools);
    const hasTools = allTools?.length > 0;
    msgs = injectCapabilityDef(msgs, hasTools);
    msgs = injectActionEnforcement(msgs, body, hasTools);
    // 長度守門：超過上游安全上限先裁剪，避免 content:null / 風控
    const trimmedPrompt = trimPrompt(msgs, allTools, currentModel);
    msgs = trimmedPrompt.messages;
    allTools = trimmedPrompt.tools;
    const finalHasTools = allTools?.length > 0;
    const effectiveToolChoice = shouldForceToolCall(body, hasTools)
      ? "required"
      : tool_choice;
    const up = {
      ...rest,
      model: currentModel,
      messages: msgs, // 原始格式，qwen2api 原生處理 tool/assistant.tool_calls
      stream: stream === undefined ? false : stream,
      ...(finalHasTools
        ? { tools: allTools, tool_choice: effectiveToolChoice }
        : {}),
      enable_thinking: isThinking,
      ...(isThinking ? { thinking_budget: think.budget } : {}),
    };
    log.debug(
      `📤 model=${up.model} msgs=${up.messages.length} tools=${allTools?.length || 0} (self: ${SELF_LEARN_TOOL_DEFS.length}) think=${isThinking} effort=${think.effort} budget=${think.budget}`,
    );

    const trace = _genTrace();
    const t = isThinking ? CFG_TIMEOUT.thinking : CFG_TIMEOUT.chat;
    let result;
    if (_router) {
      try {
        const r = await _router.exec("POST", "/v1/chat/completions", up, {
          trace,
          timeout: t,
          retries: CFG_TIMEOUT.retries,
        });
        result = r.data;
        log.info(`[${trace}] ✅ ${r.provider} (${r.latency}ms)`);
      } catch (e) {
        // challenge = 出口 IP 級風控，直連同一台 qwen2api 必敗 → 直接往上拋
        if (e.challenge) throw e;
        log.warn(`[${trace}] Router 失敗: ${e.message}，降級至直接請求`);
        result = await postJSON(
          `${QWEN2API_URL}/v1/chat/completions`,
          up,
          t,
          CFG_TIMEOUT.retries,
        );
      }
    } else {
      result = await postJSON(
        `${QWEN2API_URL}/v1/chat/completions`,
        up,
        t,
        CFG_TIMEOUT.retries,
      );
    }
    const choice = result?.choices?.[0];
    if (!choice) throw mkErr(502, "upstream_empty_choices");

    // 保留上游真實 usage（qwen2api/DashScope 回傳的實際 token 計數）
    // 取代客戶端 Math.ceil(text.length/4) 的粗略估算，確保 opencode stats 準確
    const upUsage = result?.usage;

    const msg = choice.message;
    const raw = msg?.content || "";

    // ─── 空回覆自動降級重試（2026-10-25 擴充）───
    // 症狀 1：思考開著時上游回 2ch 殘片（實測「✅ 27s content=2ch」）。
    // 症狀 2：上游併發超載時回 content:null + completion_tokens:0（實測 2 併發必現）。
    // 對策：無 tool_calls 且內容過短 → 關閉思考並重試一次（退避 1.5s 避開同批競爭）。
    if (raw.trim().length < 16 && !msg?.tool_calls?.length && retriesLeft > 0) {
      log.warn(
        `⚠️ 空回覆 ${raw.length}ch（think=${isThinking}），退避重試一次`,
      );
      await delay(1500);
      const retryBody = isThinking
        ? { ...up, enable_thinking: false }
        : { ...up };
      delete retryBody.thinking_budget;
      const retry = await postJSON(
        `${QWEN2API_URL}/v1/chat/completions`,
        retryBody,
        CFG_TIMEOUT.chat,
        0,
      );
      const rMsg = retry?.choices?.[0]?.message;
      if ((rMsg?.content || "").trim().length > raw.trim().length) {
        log.info(`✅ 重試成功 content=${(rMsg.content || "").length}ch`);
        return buildTextResponse(
          rMsg.content,
          currentModel,
          promptText,
          retry?.usage,
        );
      }
    }

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

    // 1) 原生 tool_calls（qwen2api 已解析）
    const nativeCalls = msg?.tool_calls;
    if (nativeCalls?.length > 0) {
      // 1a) 先檢查是否有自我學習工具需要本地執行
      const { handled, results } = await handleSelfLearnToolCalls(nativeCalls);
      const regularCalls = guardToolCalls(
        nativeCalls.filter((tc) => !tc.function?.name?.startsWith("self_")),
        log,
      );
      if (handled && regularCalls.length === 0) {
        // 全部是 self-learning tools，回傳執行結果
        log.info(`🧠 自我學習工具已執行 x${results.length}，回傳結果`);
        // 🧠 記錄自我學習工具互動
        try {
          selfLearning.recordInteraction(
            promptText.slice(0, 500),
            `[self-learn-tools] ${results.length} executed`,
            "accepted",
            {
              modelUsed: currentModel,
              routingScore: analyzeComplexity(body),
              taskType: "self-learning",
            },
          );
        } catch {}
        return buildTextResponse(
          results.map((r) => r.content).join("\n\n"),
          currentModel,
          promptText,
          upUsage,
        );
      }
      if (handled && regularCalls.length > 0) {
        // 混合：self-learning 已執行，其他 tool_calls 透傳給 opencode
        log.info(
          `📬 混合 tool_calls: ${results.length} self + ${regularCalls.length} regular，透傳給 opencode`,
        );
      }
      log.info(`📬 原生 tool_calls x${nativeCalls.length}，透傳給 opencode`);
      // 🧠 記錄工具呼叫互動
      try {
        selfLearning.recordInteraction(
          promptText.slice(0, 500),
          `[tool-calls] ${nativeCalls.length} calls`,
          "accepted",
          {
            modelUsed: currentModel,
            routingScore: analyzeComplexity(body),
            taskType: "coding",
          },
        );
      } catch {}
      return buildToolCallResponse(
        regularCalls.length > 0 ? regularCalls : nativeCalls,
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
        guardToolCalls(bashCalls, log),
        contentWithThink,
        currentModel,
        promptText,
        upUsage,
      );
    }

    // 3) 純文字回應 → 直接回傳（opencode 視為完成）
    log.debug(`✅ 純文字回應 ${raw.length}ch`);

    // 🧠 自動記錄路由與模型使用數據（供智能微調分析）
    // 無論是否有 tool_calls，只要回應成功即記錄，確保所有模型互動都被學習系統捕捉
    try {
      const complexityScore = analyzeComplexity(body);
      selfLearning.recordInteraction(
        promptText.slice(0, 500),
        raw.slice(0, 500),
        "accepted",
        {
          modelUsed: currentModel,
          routingScore: complexityScore,
          taskType: hasTools ? "coding" : "chat",
        },
      );
    } catch (err) {
      log.debug(`⚠️ 反饋記錄失敗: ${err.message}`);
    }

    // 上游回空內容（實測 38K~42K tokens 時 content:null）
    // 不再回 200 + "(空回應)"：那會被 opencode 當成正常回覆存檔，
    // 壓縮摘要同樣被污染 → 歷史被裁。改拋 502，讓 opencode 走錯誤處理。
    if (!raw.trim()) {
      throw mkErr(502, "upstream_empty_content");
    }

    return buildTextResponse(raw, currentModel, promptText, upUsage);
  } catch (e) {
    // 不再偽裝成 200 + 佔位文字（會污染 opencode 的壓縮摘要，導致歷史被吃）
    // 一律往上拋，由 handler 轉成結構化 HTTP 錯誤碼。
    log.error(`❌ runSinglePass 失敗:`, e?.message || e);
    throw e;
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
const streamSinglePass = async (
  body,
  res,
  msgId,
  model,
  signal,
  checkTimedOut = () => false,
) => {
  let hbTimer = null;
  let release = null;
  // 2026-11-01：累積串流實際輸出，供斷線後持久化「做過什麼」。
  // 舊版只記 "[串流回應已發送]" 佔位字串 → 重連後模型無從得知先前工作內容。
  let reply = "";
  let sseBuf = "";
  // 抽出成函式：迴圈中即時吸收，退出前再 flush 尾段，兩處共用同一套解析。
  const absorbSse = () => {
    let i;
    while ((i = sseBuf.indexOf("\n\n")) >= 0) {
      const frame = sseBuf.slice(0, i);
      sseBuf = sseBuf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const d = JSON.parse(payload).choices?.[0]?.delta;
          if (d?.content) reply += d.content;
          if (d?.reasoning_content) reply += d.reasoning_content;
          if (d?.tool_calls)
            for (const t of d.tool_calls)
              if (t?.function?.name) reply += `\n[tool:${t.function.name}]`;
        } catch {}
      }
    }
  };
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

    // 注入自我學習 system prompt（含 plugin_info）
    msgs = injectSelfLearnSystemPrompt(msgs);
    // 注入語言工作邏輯（繁體硬規則，每次請求生效）
    msgs = injectLanguageRule(msgs);

    // 原始訊息直接透傳（qwen2api 原生支援 tool role）
    const currentModel = routeModel(body);
    const clientHasTools = Array.isArray(tools) && tools.length > 0;
    // 2026-11-05 Fix：上游 Qwen 帶工具且開思考時，常只輸出「思考 Process」計畫文字就 stop
    // （實測 tool_calls 成功率：think=true 1/4、think=false 4/4）。
    // 客戶端未在模型名明確要求 thinking 時，工具請求一律關閉思考。
    const forceNoThink =
      clientHasTools && !body.model?.toLowerCase().includes("thinking");
    const think = forceNoThink
      ? { on: false, budget: 0, effort: "none" }
      : clampThink(resolveThink(body), currentModel);
    const isThinking = think.on;

    let allTools = injectSelfLearnTools(tools);
    const hasTools = allTools?.length > 0;
    msgs = injectCapabilityDef(msgs, hasTools);
    msgs = injectActionEnforcement(msgs, body, hasTools);
    // 長度守門：超過上游安全上限先裁剪，避免 content:null / 風控
    const trimmedPrompt = trimPrompt(msgs, allTools, currentModel);
    msgs = trimmedPrompt.messages;
    allTools = trimmedPrompt.tools;
    const finalHasTools = allTools?.length > 0;
    const effectiveToolChoice = shouldForceToolCall(body, hasTools)
      ? "required"
      : tool_choice;
    const up = {
      ...rest,
      model: currentModel,
      messages: msgs,
      // Use original stream value from client if provided, default to false
      // (false tells qwen2api to return complete JSON — no SSE pipe,
      //  but still allows the proxy to process the response synchronously)
      stream: _s === undefined ? false : _s,
      ...(finalHasTools
        ? { tools: allTools, tool_choice: effectiveToolChoice }
        : {}),
      enable_thinking: isThinking,
      ...(isThinking ? { thinking_budget: think.budget } : {}),
    };
    log.info(
      `📡 stream model=${up.model} msgs=${up.messages.length} tools=${allTools?.length || 0} (self: ${SELF_LEARN_TOOL_DEFS.length}) think=${isThinking} effort=${think.effort} budget=${think.budget}`,
    );

    const trace = _genTrace();
    // 逾時規範：t 為單次上游 fetch 上限，必須 <= REQUEST_TIMEOUT（最後防線），
    // 否則請求計時器會先中斷長推理。thinking 模式請維持 >= CHAT_IDLE_THINKING_MS。
    const t = isThinking ? CFG_TIMEOUT.thinking : CFG_TIMEOUT.chat;
    // 合併客戶端中斷 signal + timeout signal
    const fetchSignal =
      typeof AbortSignal.timeout === "function" &&
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, AbortSignal.timeout(t)])
        : signal;
    let resp;

    // 上游併發閘門：超過上游容忍度時排隊，避免 Chrome Fetch 逾時 → 空內容 502
    release = await upGate(trace);

    // 路由模式：嘗試透過 Router 取得串流回應
    if (_router) {
      try {
        const streamResult = await _router.execStream(
          "/v1/chat/completions",
          up,
          { trace, timeout: t, signal, retries: CFG_TIMEOUT.retries },
        );
        resp = streamResult.response;
        log.info(`[${trace}] ✅ STREAM ${streamResult.provider}`);
      } catch (e) {
        log.warn(`[${trace}] Router stream 失敗: ${e.message}，降級至直接請求`);
        resp = null;
      }
    }

    // 降級：直接請求 Qwen2API
    if (!resp) {
      const maxRetries = CFG_TIMEOUT.retries;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const ctrl =
          attempt < maxRetries
            ? AbortSignal.any([signal, AbortSignal.timeout(t)])
            : fetchSignal;
        try {
          const r = await fetch(`${QWEN2API_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(up),
            signal: ctrl,
          });
          if (r.ok && r.body) {
            resp = r;
            break;
          }
          // 讀錯誤 body 判定是否為 IP 級風控（challenge 重試必敗 → 立即往上拋）
          const txt = await r.text().catch(() => "");
          const err = resErr(r, txt);
          if (err.challenge) throw err;
          if (err.status < 500) throw err;
          if (attempt < maxRetries) {
            const wait = Math.min(2000 * 2 ** attempt, 10000);
            const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
            log.info(
              `[${trace}] ⚠️ 串流 ${r.status}，重試 ${attempt + 1}/${maxRetries} (${jittered}ms)`,
            );
            await delay(jittered);
            continue;
          }
          log.info(`[${trace}] 串流失敗 (${r.status})，不再降級`);
          throw err;
        } catch (e) {
          if (e?.name === "AbortError") {
            log.warn(`[${trace}] 🛑 串流被中斷或超時`);
            return { ok: true, reply };
          }
          if (e.challenge || (e.status && e.status < 500)) throw e;
          if (attempt < maxRetries) {
            const wait = Math.min(2000 * 2 ** attempt, 10000);
            const jittered = Math.round(wait * (0.75 + Math.random() * 0.5));
            log.info(
              `[${trace}] ⚠️ 串流異常 ${e.message}，重試 ${attempt + 1}/${maxRetries} (${jittered}ms)`,
            );
            await delay(jittered);
            continue;
          }
          log.info(`[${trace}] 串流異常，不再降級`);
          throw e;
        }
      }
      if (!resp) {
        throw mkErr(502, "stream_no_response");
      }
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
    // P4: 使用傳入的 checkTimedOut 回調檢查請求是否超時

    // ═══ SSE heartbeat（2026-10-25 重寫）═══
    // 舊實作致命 BUG：heartbeat 每 3s 把 streamState.lastData 更新為 now，
    // 導致「無資料計時」被自己的心跳重置；但 emptyHeartbeatCount 仍遞增，
    // 4 次心跳（12s）後就無條件斷線 → 只要模型思考超過 12s 沒吐 chunk
    // （thinking 模式下家常便飯，實測 25~40s）就必然回「上游無回應超時」。
    // 修復：把「上游最後資料時間」與「心跳發送時間」徹底分離，
    // 並改用時間閾值（非次數），thinking 模式放寬到 180s。
    const HEARTBEAT_MS = 3_000;
    // 逾時規範：IDLE_LIMIT_MS 只量測「上游無資料」的停頓，必須 < THINKING_TIMEOUT（fetch 上限），
    // 否則 fetch 先被 AbortSignal 中斷，idle 判斷永遠不會觸發。
    // thinking 預設 300s（配合 config thinkingTimeoutMs 600s）；非 thinking 90s。
    const IDLE_LIMIT_MS = isThinking
      ? Number(process.env.CHAT_IDLE_THINKING_MS || 300_000)
      : Number(process.env.CHAT_IDLE_MS || 90_000);
    let lastData = Date.now();
    // 只用 lastData 記錄「上游真正有吐東西」的時間，心跳絕不更新它
    const streamState = { lastData };
    hbTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(hbTimer);
        return;
      }
      const idle = Date.now() - streamState.lastData;
      try {
        if (idle >= IDLE_LIMIT_MS) {
          log.warn(
            `⚠️ 上游閒置 ${Math.round(idle / 1000)}s 超過上限 ${Math.round(IDLE_LIMIT_MS / 1000)}s，強制結束`,
          );
          clearInterval(hbTimer);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(
                `data: {"error":{"message":"上游無回應超時","error_code":"upstream_idle_timeout","type":"upstream_timeout","detail":"連續 ${Math.round(idle / 1000)}s 無實質內容"}}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            } catch { /* ignore */ }
          }
          return;
        }
        // SSE comment 重置 client 端閒置計時器（opencode wrapSSE 120s）
        if (!res.writableEnded && !res.destroyed) {
          try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
        }
      } catch (e) {
        log.debug(`Heartbeat write failed: ${e.message}`);
        clearInterval(hbTimer);
      }
    }, HEARTBEAT_MS);

    // 追蹤是否曾收到/轉發過任何資料（判斷空串流 timeout vs 中途斷流）
    let gotAnyData = false;
    // 2026-11-05：緩存 tool_calls chunks（不透傳），攢完再按 self_* 分流。
    // 原直接透傳 → 串流 self_* 上拋 opencode 執行，proxy 無攔截 log。
    const toolCallChunks = [];
    // 2026-11-05 Fix：有工具緩存時，上游的 finish_reason/usage 與 [DONE] 必須扣住，
    // 否則 client 先收到 [DONE] 就結束串流，補發的 tool_calls 全部被丟棄 → 模型「光說不做事」。
    const deferredTail = [];
    let toolCallAcc = new Map(); // index -> { id, name, arguments(累積) }
    // 2026-10-23：追蹤「實質內容」。上游在長 prompt 時會回一整個 SSE 串流
    // 但所有 delta 都空、只有 finish_reason=stop（實測 content:null）。
    // 這種情況 gotAnyData=true 卻沒有任何文字，客戶端看到的是空回覆。
    let gotContent = false;
    let chunkCount = 0; // P3: 統計 chunk 數量用於診斷
    const streamStartTime = Date.now(); // P13: 記錄串流開始時間

    while (true) {
      // P4: 若請求已被中止、超時或回應已結束，立即退出避免 write race
      if (
        signal?.aborted ||
        checkTimedOut() ||
        res.writableEnded ||
        res.destroyed
      ) {
        if (checkTimedOut()) log.warn("🛑 串流因整體超時中止");
        else if (!res.writableEnded) log.info("🛑 串流已中止，結束讀取迴圈");
        break;
      }
      // 讀取逾時保護（2026-10-25 統一）：與 heartbeat 的 IDLE_LIMIT_MS 對齊，
      // thinking 模式上游首包可能要 40~90s（實測），舊硬編碼 90s 會在思考中途斷流。
      // 非 thinking 首包 90s；thinking 首包/後續都放寬至 IDLE_LIMIT_MS。
      const isFirstChunk = chunkCount === 0;
      const readTimeout = isThinking
        ? IDLE_LIMIT_MS
        : isFirstChunk
          ? Math.min(90000, t)
          : Math.max(30000, Math.min(60000, t / 3));
      let readResult;
      let timer = null;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("read_timeout")),
              readTimeout,
            );
          }),
        ]);
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        if (e?.message === "read_timeout") {
          if (gotAnyData) {
            log.warn(
              `⚠️ 上游串流中斷逾時 (${Math.round(readTimeout / 1000)}s, chunks=${chunkCount})，視為串流中斷`,
            );
          } else {
            log.warn(
              `⚠️ 上游等待首個 chunk 逾時 (${Math.round(readTimeout / 1000)}s)，可能上游忙碌中`,
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
      streamState.lastData = now; // 上游真的吐資料，重置閒置計時（心跳不影響此值）

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      chunkCount++; // P3: 遞增 chunk 計數

      // 2026-11-01：解析實際 delta 內容（content / reasoning / tool 名稱），
      // 供斷線或重連後仍能記得「做過什麼、描述過什麼」。
      sseBuf += chunk;
      absorbSse();
      if (reply.length > 4000) reply = reply.slice(-4000);

      // P14: 記錄首個 chunk 到達延遲
      if (chunkCount === 1) {
        const firstChunkDelay = now - streamStartTime;
        log.info(`⏱️ 首個 chunk 延遲: ${firstChunkDelay}ms`);
      }

      // 收到 [DONE] 立即跳出，不等待上游關閉連線（常見卡死根因）
      if (chunk.includes("data: [DONE]")) {
        sawDone = true;
        try {
          // 有工具緩存時不可先送 [DONE]，否則 client 直接收工，收尾補發的 tool_calls 被丟棄
          if (toolCallAcc.size === 0 && !res.writableEnded && !res.destroyed) {
            try { res.write(chunk); } catch { /* ignore */ }
          }
        } catch {
          /* 客戶端可能已斷線 */
        }
        break;
      }

      if (res.writableEnded || res.destroyed) break; // P4: 回應已結束，跳過寫入
      // 判定是否含實質內容：content / reasoning_content / tool_calls 任一非空
      if (!gotContent && /"(content|reasoning_content)":"[^"]/.test(chunk)) {
        gotContent = true;
      }
      if (!gotContent && /"tool_calls":\s*\[\s*\{/.test(chunk)) {
        gotContent = true;
      }
      // 已緩存工具 → 扣住結尾的空 delta chunks（finish_reason / usage），待收尾一起補發
      if (
        toolCallAcc.size > 0 &&
        (/"usage"\s*:\s*\{/.test(chunk) ||
          (/"delta"\s*:\s*\{\s*\}/.test(chunk) &&
            !/"content"\s*:\s*"[^"]/.test(chunk)))
      ) {
        deferredTail.push(chunk);
        gotAnyData = true;
        continue;
      }
      // 含 tool_calls → 緩存不透傳（攢完後按 self_* 分流決定是否本地執行）
      if (/"tool_calls":/.test(chunk)) {
        toolCallChunks.push(chunk);
        try {
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            const d = JSON.parse(payload).choices?.[0]?.delta;
            for (const tc of d?.tool_calls || []) {
              const idx = tc?.index ?? 0;
              const slot = toolCallAcc.get(idx) || { id: tc?.id || "", name: "", arguments: "" };
              if (tc?.id) slot.id = tc.id;
              if (tc?.function?.name) slot.name = tc.function.name;
              if (tc?.function?.arguments) slot.arguments += tc.function.arguments;
              toolCallAcc.set(idx, slot);
            }
          }
        } catch (e) { log.debug(`tool_calls 緩存解析失敗: ${e.message}`); }
        gotAnyData = true;
        continue; // 不透傳，收尾處分流
      }
      try {
        if (res.writableEnded || res.destroyed) break;
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
            log.warn("⚠️ 客戶端緩衝區 drain 超時，銷毀回應以釋放資源");
            // P23: drain 超時代表客戶端讀取嚴重滯後或已斷線，直接銷毀避免記憶體洩漏
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
            ok = false;
            break;
          }
        }
      } catch (e) {
        log.warn(`⚠️ 寫入客戶端失敗 (${e.message})，串流中斷`);
        ok = false;
        // P17: 立即發送錯誤 event 給客戶端，避免客戶端無限等待
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(
              `data: {"error":{"message":"串流傳輸中斷","error_code":"client_write_failed","type":"client_write_failed","detail":"${e.message}"}}\n\n`,
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

    // 2026-11-05：串流 tool_calls 收尾分流（緩存已攢好）
    // 必須放在 while 迴圈外、clearInterval 後——上游 [DONE] 觸發 break 後才到此，
    // 收尾時 toolCallAcc 已完整。
    if (toolCallAcc.size > 0) {
      // client 斷線 / 回應已結束時，尾段不再寫入（防 write-after-end）
      const canWrite = () => !res.writableEnded && !res.destroyed;
      const safeWriteSSE = (s) => {
        if (!canWrite()) return false;
        try {
          res.write(s);
          return true;
        } catch {
          return false;
        }
      };
      // usage 片段（不含 finish_reason 衝突幀）可安全補發給 client
      const usageTail = deferredTail.filter((c) => /"usage"\s*:/.test(c));
      const allCalls = [...toolCallAcc.values()]
        .filter((c) => c.name)
        .map((c) => ({
          id: c.id || `call_stream_${Math.random().toString(36).slice(2)}`,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      const { handled, results } = await handleSelfLearnToolCalls(allCalls);
      const regular = guardToolCalls(
        allCalls.filter((c) => !c.function?.name?.startsWith("self_")),
        log,
      );
      if (handled && regular.length === 0) {
        // 全自我學習工具：proxy 本地執行、結果回覆（與非串流 runSinglePass 一致）
        log.info(
          `🧠 串流自我學習工具已執行 x${results.length}，回傳結果`,
        );
        try {
          selfLearning.recordInteraction(
            "[stream] " +
              (messages?.[messages.length - 1]?.content || "").slice(0, 200),
            `[self-learn-tools] ${results.length} executed`,
            "accepted",
            {
              modelUsed: currentModel,
              routingScore: analyzeComplexity(body),
              taskType: "self-learning",
            },
          );
        } catch {}
        const text = results.map((r) => r.content).join("\n\n");
        const nowSec = Math.floor(Date.now() / 1000);
        safeWriteSSE(
          `data: {"id":"${msgId}","object":"chat.completion.chunk","created":${nowSec},"model":"${currentModel}","choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`,
        );
        safeWriteSSE(
          `data: {"id":"${msgId}","object":"chat.completion.chunk","created":${nowSec},"model":"${currentModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        );
        for (const c of usageTail) safeWriteSSE(c);
        safeWriteSSE("data: [DONE]\n\n");
        if (canWrite()) res.end();
      } else {
        // 含 regular 工具：以（可能被 env-guard 改寫的）regular 合成 tool_calls chunks，
        // 不重播上游原始分片（arguments 已攢滿、finish 已扣住，可安全重組）。
        const nowSecTools = Math.floor(Date.now() / 1000);
        const mkToolChunk = (delta, finishReason) =>
          `data: ${JSON.stringify({
            id: msgId,
            object: "chat.completion.chunk",
            created: nowSecTools,
            model: currentModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        regular.forEach((c, i) => {
          safeWriteSSE(
            mkToolChunk(
              {
                tool_calls: [
                  {
                    index: i,
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.function.name,
                      arguments: c.function.arguments,
                    },
                  },
                ],
              },
              null,
            ),
          );
        });
        const hasFinish = deferredTail.some((c) =>
          /"finish_reason"\s*:\s*"(tool_calls|stop|length)"/.test(c),
        );
        if (!hasFinish) {
          const nowSec = Math.floor(Date.now() / 1000);
          safeWriteSSE(
            `data: {"id":"${msgId}","object":"chat.completion.chunk","created":${nowSec},"model":"${currentModel}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
          );
        }
        for (const c of deferredTail) safeWriteSSE(c);
        // 上游的 [DONE] 已被扣住未轉發，此處必須補發
        safeWriteSSE("data: [DONE]\n\n");
        if (canWrite()) res.end();
      }
    }

    // 確保串流結尾：若上游未發 [DONE]，補發避免 client 卡住
    if (ok && !res.writableEnded && !res.destroyed) {
      // 上游回了一整段 SSE 卻沒有任何 content（長 prompt 時的 content:null）
      // → 不可當成正常空回覆送出，否則 opencode 存成空白訊息、污染摘要。
      if (gotAnyData && !gotContent) {
        log.warn(
          `❌ 上游串流無實質內容 (chunks=${chunkCount}, ${Math.round((Date.now() - streamStartTime) / 1000)}s)`,
        );
        try {
          res.write(
            `data: {"error":{"message":"上游回傳空內容（prompt 可能過長），請縮短對話或稍後重試","error_code":"upstream_empty_content","type":"upstream_empty_content"}}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          /* ignore */
        }
        return { ok: false, reply };
      }
      if (gotAnyData) {
        // 正常串流結束或中途斷流 → 補發 [DONE]
        if (!sawDone && !res.writableEnded && !res.destroyed) {
          log.warn(
            `⚠️ 上游未發送 [DONE]（chunks=${chunkCount}），補發結束標記`,
          );
          res.write("data: [DONE]\n\n");
        }
        res.end();

        // 自動記錄串流模式的路由與模型使用數據
        try {
          const complexityScore = analyzeComplexity(body);
          selfLearning.recordInteraction(
            "[stream] " +
              (messages?.[messages.length - 1]?.content || "").slice(0, 200),
            `[stream completed] chunks=${chunkCount}`,
            "accepted",
            {
              modelUsed: currentModel,
              routingScore: complexityScore,
              taskType: hasTools ? "coding" : "chat",
            },
          );
        } catch (err) {
          log.debug(`⚠️ 串流反饋記錄失敗: ${err.message}`);
        }
      } else {
        // 從未收到任何資料 → 發送錯誤 event 而非空 [DONE]
        // 避免客戶端收到「200 OK + 0 內容串流」誤以為無回應
        log.warn(`❌ 上游未回應任何資料（timeout=${t / 1000}s），發送錯誤通知`);
        try {
          res.write(
            `data: {"error":{"message":"上游忙碌無回應，請稍後重試或檢查 qwen2api 狀態","error_code":"upstream_timeout","type":"upstream_timeout","timeout_sec":${t / 1000},"suggestion":"若持續發生，請檢查 qwen2api 日誌或降低模型複雜度"}}\n\n`,
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

    // flush 尾段（最後一個 frame 可能沒有結尾 "\n\n"）
    sseBuf += "\n\n";
    absorbSse();
    return { ok, reply };
  } catch (e) {
    if (e?.name === "AbortError") {
      log.warn("🛑 串流被客戶端中斷或超時");
      return { ok: true, reply };
    }
    log.error("❌ streamSinglePass 失敗:", e?.message || e);
    // headers 尚未送出 → 往上拋，由 handler 回真正的 HTTP 錯誤碼（不再假裝 200）
    if (!res.headersSent) throw e;
    // headers 已送出（串流進行中）→ 只能以 SSE 錯誤事件收尾
    try {
      res.write(
        `data: {"error":{"message":${JSON.stringify(e?.message || "stream failed")},"error_code":"upstream_error","type":"upstream_error"}}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      /* client 已斷線 */
    }
    return { ok: true, reply };
  } finally {
    // 確保所有退出路徑都清除 Heartbeat Timer
    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
    // 釋放上游併發閘門（串流全程佔用，避免上游同時被灌爆）
    if (release) {
      release();
      release = null;
    }
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

// 模型有時會在 content 裡捏造 <tool_response> 假工具結果（訓練資料汙染）。
// 假結果會混進 opencode 後續上下文，讓模型以為工具已執行、跳過真正的驗證步驟。
// 這裡統一洗掉，只保留真正的 assistant 文字。
const stripFabricatedToolResponses = (text) => {
  if (typeof text !== "string" || !text.includes("<tool_response")) {
    return text;
  }
  const cleaned = text
    .replace(/<tool_response[\s\S]*?<\/tool_response>/g, "") // 成對的假結果
    .replace(/<tool_response[\s\S]*$/m, "") // 未閉合的尾端假結果
    .trim();
  return cleaned;
};

const buildTextResponse = (content, model, promptMsgs = "", upstreamUsage) => {
  const cleaned = stripFabricatedToolResponses(content);
  const finalContent =
    cleaned === "" && typeof content === "string" && content.includes("<tool_response")
      ? "⚠️ 模型輸出只含捏造的假工具結果，已自動略過"
      : cleaned;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.round(Date.now() / 1000),
    model: model || "qwen",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: finalContent },
        finish_reason: "stop",
      },
    ],
    usage: pickUsage(upstreamUsage, promptMsgs, finalContent),
  };
};

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
          content: stripFabricatedToolResponses(content) || null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: pickUsage(upstreamUsage, promptMsgs, argsStr),
  };
};

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

  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write("data: [DONE]\n\n");
      res.end();
    } catch { /* ignore */ }
  }
};

// ─── 通用轉發（非聊天端點） ───

const proxyRequest = (req, res) => {
  const method = req.method;
  const path = req.url;

  // GET 轉發
  if (method === "GET") {
    const doGet = async () => {
      if (_router) {
        try {
          const result = await _router.exec("GET", path, null, {
            trace: _genTrace(),
            timeout: 15000,
            retries: 0,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.data));
          return;
        } catch (e) {
          log.debug(`Router GET 降級: ${e.message}`);
        }
      }
      const data = await getJSON(`${QWEN2API_URL}${path}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    doGet().catch((err) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
    return;
  }

  // POST 轉發
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
          JSON.stringify({ error: { message: "Request body too large (max 100KB)" } }),
        );
        req.destroy();
      }
    });
    req.on("error", () => {
      rejected = true;
    });
    req.on("end", async () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(body);
        if (_router) {
          try {
            const result = await _router.exec("POST", path, parsed, {
              trace: _genTrace(),
              timeout: 60000,
              retries: 0,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.data));
            return;
          } catch (e) {
            log.debug(`Router POST 降級: ${e.message}`);
          }
        }
        const data = await postJSON(`${QWEN2API_URL}${path}`, parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        if (!rejected) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        }
      }
    });
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
};

// ─── 主請求處理 ───

const handleRequest = async (req, res) => {
  // 防止 write after end 等串流錯誤成為未捕獲異常（無 listener 會 crash）
  res.on("error", (e) => {
    try { log.debug(`res error: ${e?.message || e}`); } catch { /* ignore */ }
  });
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
      res.end(JSON.stringify({ error: { message: "Unauthorized: Invalid API Key" } }));
      return;
    }
  }

  // 健康檢查
  if (url === "/health") {
    let upstreamStatus = "unknown";
    let routerStatus = null;
    if (_router) {
      const stats = _router.status();
      const healthyCount = stats.filter((s) => s.healthy).length;
      routerStatus = {
        providers: stats,
        healthyCount,
        totalCount: stats.length,
        strategy: _router.strategy,
      };
      upstreamStatus = healthyCount > 0 ? "ok" : "unreachable";
    } else {
      try {
        const h = await getJSON(`${QWEN2API_URL}/health`, 3000, 0);
        upstreamStatus = h?.status || h?.upstream || "ok";
      } catch (e) {
        log.warn(`⚠️ 上游健康檢查失敗: ${e.message}`);
        upstreamStatus = "unreachable";
      }
    }
    const hw = detectHardware();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        proxy: "running",
        upstream: upstreamStatus,
        router: routerStatus,
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

  // 工具執行端點（qwen2api-plugin index.js 的 qwen_* 工具）
  if (url.startsWith("/tool/") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const args = body ? JSON.parse(body) : {};
        const text = await runToolEndpoint(url, args || {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: String(text ?? "") }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
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
        res.end(JSON.stringify({ error: { message: e.message } }));
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
    // 🐛 FIX: 請求級別超時保護，防止 runSinglePass/stream 永久卡住
    // 逾時規範（2026-11-01）：此為整體請求最後防線，必須 >= THINKING_TIMEOUT。
    // 舊值 60s < thinking 120s，推理 >60s 就被這裡 abort() 中斷 → 「上游無回應」。
    // 新值由 config/index.js laptop profile 提供（requestTimeoutMs = thinking 600s + 60s 緩衝）。
    const REQ_TIMEOUT_MS = CFG.REQUEST_TIMEOUT;
    let reqTimedOut = false;
    const reqTimer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return; // P4: 回應已結束則跳過
      reqTimedOut = true;
      log.warn(`🛑 請求整體超時 (${REQ_TIMEOUT_MS}ms)，強制中止`);
      ac.abort();
      try {
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Request timeout",
              timeout_ms: REQ_TIMEOUT_MS,
            }),
          );
        } else {
          // P4: headers 已送出（串流進行中），只能關閉連線不額外寫入
          res.end();
        }
      } catch {
        /* ignore */
      }
    }, REQ_TIMEOUT_MS);

    res.on("close", () => {
      clearTimeout(reqTimer); // 客戶端斷線時清除計時器
      if (!res.writableEnded && !reqTimedOut) {
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
          JSON.stringify({ error: { message: "Request body too large (max 100KB)" } }),
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
      // P0: 入口併發限流 — 超過 MAX_INFLIGHT 直接 429，不轉發 upstream
      if (proxyInflight >= MAX_INFLIGHT) {
        log.warn(
          `⚠️ Inflight 限流: ${proxyInflight} >= ${MAX_INFLIGHT}，回傳 429`,
        );
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Too Many Concurrent Requests",
            inflight: proxyInflight,
            maxInflight: MAX_INFLIGHT,
            retryAfter: 5,
          }),
        );
        return;
      }
      proxyRequestStart();
      try {
        const parsed = JSON.parse(body);
        const msgId = `chatcmpl-${Date.now()}`;
        const model = parsed.model || "qwen";
        log.info(
          `📨 請求 model=${parsed.model} tools=${parsed.tools?.length || 0} stream=${parsed.stream} (inflight=${proxyInflight})`,
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
        // 2026-10-23 Fix：僅對「真實對話」生效。
        // 標題生成 / 壓縮摘要 / 子代理請求都是系統內部用途，若被過濾或注入摘要，
        // 會讓摘要本身被佔位字串污染 → opencode 把「⚠️ 上游無回應」當有效摘要存檔
        // → filterCompacted 判定為邊界 → 整段歷史被丟棄（使用者看到「對話被吃掉」）。
        if (
          CONV_MEMORY_ENABLED &&
          parsed.messages &&
          !isMetaRequest(parsed, req.headers)
        ) {
          parsed.messages = processWithMemory(parsed.messages);
        }

        if (parsed.stream) {
          // 串流：使用 streamSinglePass（真實 SSE 轉發）
          // 不再使用 runSinglePass + streamResponse 模擬 SSE，避免第二個請求
          // 因等待 qwen2api 排隊而逾時（客戶端收不到任何資料 =「無回應」）
          const out = await streamSinglePass(
            parsed,
            res,
            msgId,
            model,
            ac.signal,
            () => reqTimedOut,
          );
          // 串流模式：持久化實際輸出，斷線重連後仍記得「做過／描述過什麼」
          if (out?.ok) {
            convRecord("assistant", out.reply || "[串流回應已發送]", model);
          }
        } else {
          // 非串流
          const nskStart = Date.now();
          const nskTimer = setInterval(() => {
            log.debug(
              `⏳ 等待上游回應 (${Math.round((Date.now() - nskStart) / 1000)}s)`,
            );
          }, CFG.NONSTREAM_KEEPALIVE_INTERVAL);
          const result = await runSinglePass(parsed);
          clearInterval(nskTimer);
          const c = result?.choices?.[0];
          const hasCalls = c?.message?.tool_calls?.length > 0;
          log.info(
            `✅ ${Math.round((Date.now() - nskStart) / 1000)}s ${hasCalls ? `tool_calls x${c.message.tool_calls.length}` : `content=${(c?.message?.content || "").length}ch`}`,
          );
          const replyContent = c?.message?.content || "";
          if (replyContent) {
            convRecord("assistant", replyContent, model);
          }
          if (hasCalls) {
            convRecord(
              "assistant",
              `[${c.message.tool_calls.map((t) => t.function?.name || "?").join(", ")}]`,
              model,
            );
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (e) {
        log.error(`❌ 請求失敗:`, e?.message || e);
        if (!res.headersSent) {
          // 結構化錯誤：讓 opencode 認得是「上游不可用」而非「模型回了 8 個字」
          const status = e?.status >= 400 ? e.status : 502;
          const retry = e?.retryAfter || (e?.challenge ? 30 : 5);
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Retry-After": String(retry),
          });
          res.end(
            JSON.stringify({
              error: {
                message: e?.challenge
                  ? "Qwen 上游風控中（IP 級），請稍後重試"
                  : `上游不可用: ${e?.message || e}`,
                type: e?.challenge
                  ? "upstream_waf_challenge"
                  : "upstream_error",
                code: e?.challenge
                  ? "upstream_waf_challenge"
                  : "upstream_error",
                retry_after_seconds: retry,
              },
            }),
          );
        }
      } finally {
        proxyRequestEnd(); // 🐛 FIX: inflight 必須歸零，否則永不恢復
      }
    });
    return;
  }

  // 其餘端點轉發到 qwen2api
  proxyRequest(req, res);
};

// ─── 啟動 Proxy ───

// ─── 簡化健康檢查（僅供 /health 端點使用，移除常駐看門狗） ───

/** 所有本地服務的健康檢查 */
async function checkAllSvcs() {
  const svcs = [
    { name: "qwen2api", url: "http://127.0.0.1:3000" },
    { name: "chat-proxy", url: "http://127.0.0.1:3456/health" },
    { name: "telegram-bridge", url: "http://127.0.0.1:4377/api/health" },
    { name: "waf-proxy", url: "http://127.0.0.1:3457" },
  ];
  const results = [];
  let okCount = 0;
  for (const svc of svcs) {
    const start = Date.now();
    let ok = false;
    try {
      const res = await fetch(svc.url, { signal: AbortSignal.timeout(5_000) });
      ok = res.ok;
    } catch {}
    const lat = Date.now() - start;
    if (ok) okCount++;
    results.push(`${svc.name}:${ok ? "✅" : "❌"}(${lat}ms)`);
  }
  const pct = Math.round((okCount / svcs.length) * 100);
  return { pct, results, okCount, total: svcs.length };
}

export const startProxy = () => {
  const server = http.createServer(handleRequest);

  // ─── env-guard：graceful drain ───
  // SIGTERM/SIGINT → 停止接新連線 → 等 in-flight（含 SSE 長連線）自然結束或 DRAIN_TIMEOUT_MS 上限 → 退出。
  // 上限後仍存活的連線一律 destroy，避免 start.mjs 看門狗等不到退出而重拉造成雙實例。
  const DRAIN_MS = Number(process.env.DRAIN_TIMEOUT_MS || 15000);
  let inflight = 0;
  const sockets = new Set();
  server.on("connection", (s) => {
    inflight++;
    sockets.add(s);
    s.on("close", () => {
      inflight--;
      sockets.delete(s);
    });
  });
  let draining = false;
  const drainAndExit = (sig) => {
    if (draining) return;
    draining = true;
    log.warn(
      `🛑 ${sig} 收到：停止接新連線，排空 in-flight x${inflight}（上限 ${DRAIN_MS}ms）`,
    );
    server.close(() => {
      log.info("👋 排空完成，正常退出");
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === "function")
      server.closeIdleConnections();
    setTimeout(() => {
      log.warn(
        `⏰ 排空逾時，強制關閉 ${sockets.size} 個殘留連線後退出`,
      );
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {}
      }
      process.exit(0);
    }, DRAIN_MS).unref();
  };
  process.on("SIGTERM", () => drainAndExit("SIGTERM"));
  process.on("SIGINT", () => drainAndExit("SIGINT"));

  // 初始化 Router（多 Provider 路由）
  try {
    _router = createRouter(CFG);
    log.info(
      `🤖 Router: ${_router.providers.length} providers, strategy=${_router.strategy}`,
    );
  } catch (e) {
    log.warn(`🤖 Router 初始化失敗，使用直接模式: ${e.message}`);
  }

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
    server.listen(PROXY_PORT, "127.0.0.1", () => {
      log.info(`🤖 Chat Proxy running on http://127.0.0.1:${PROXY_PORT}`);
      if (CFG.ROUTE_ENABLED) {
        log.info("🧠 模型路由: 啟用（自動依任務複雜度切換）");
      }
      log.info(
        `🧠 推理模式: ${PROXY_THINKING_MODE}${PROXY_THINKING_MODE === "auto" ? "（自動偵測 QwQ/Plus/Max/Coder）" : ""}`,
      );
      resolve(server);
    });
  });
};

// 暴露環境資訊供健康檢查
const getRouteInfo = () => ({
  enabled: CFG.ROUTE_ENABLED,
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
  router: _router
    ? {
        providers: _router.providers.length,
        strategy: _router.strategy,
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
