/**
 * intelligent-tuning.js — 智能微調層（持久化版）
 *
 * 基於模型即時行為觀察，動態調整 tool prompt 風格與系統參數。
 * 補足 evolution-engine（長期統計）與 self-learning（用戶偏好）之間
 * 的短中期即時調整缺口。
 *
 * ═══ Fix 2026-07-04: 持久化支援 ═══
 * 問題：進程重啟後 _patterns 中的行為數據全部遺失，
 * 導致每次重啟都要從頭學習模型行為（停滯率、延遲、prompt 風格）。
 * 修復：每次 recordResponse 後 debounced 保存至 ~/.opencode/tuning/tuning-data.json，
 * 啟動時自動載入。
 *
 * 核心機制：
 * 1. 行為追蹤 — 每次模型回應記錄其模式（停滯/完成/拒絕/空內容）
 * 2. Prompt 動態調整 — 根據模型行為調整 tool prompt 語氣與內容
 * 3. 參數自調 — 動態調整重試次數、超時閾值、停滯檢測敏感度
 * 4. 路由提示 — 提供即時路由建議（給 chat-proxy.js 參考）
 *
 * 整合方式（chat-proxy.js）：
 *   import * as tune from "./intelligent-tuning.js";
 *   tune.recordResponse(model, "stall");
 *   const prompt = tune.buildAdaptivePrompt(tools);
 *   const hint = tune.getRoutingHint(model);
 */

import fs from "node:fs";
import path from "node:path";
import { makeLogger } from "./color.js";
import { OPENCODE_DIR } from "./config/paths.js";

const log = makeLogger("tuning", "secondary");

// ═══ 持久化路徑 & 檔案操作 ═══

const _tuningDir = path.join(OPENCODE_DIR, "tuning");
const _persistPath = path.join(_tuningDir, "tuning-data.json");

/**
 * 從磁碟載入持久化的 tuning 數據
 */
const _load = () => {
  try {
    if (!fs.existsSync(_persistPath)) {
      log.debug("無持久化 tuning 數據，從頭開始");
      return null;
    }
    const raw = fs.readFileSync(_persistPath, "utf-8");
    const data = JSON.parse(raw);
    // 基本驗證
    if (!data || !data.patterns || typeof data.patterns !== "object") {
      log.warn("⚠️ tuning 數據格式異常，跳過載入");
      return null;
    }
    log.debug(
      `📂 已載入 tuning 數據: ${Object.keys(data.patterns).length} 模型, ${data.globalResponseCount || 0} 次回應`,
    );
    return data;
  } catch (e) {
    log.warn(`⚠️ 載入 tuning 數據失敗: ${e.message}`);
    return null;
  }
};

/**
 * 保存 tuning 數據至磁碟（同步寫入，避免進程退出時遺失）
 */
const _save = () => {
  try {
    const patterns = {};
    for (const [model, p] of _patterns) {
      patterns[model] = { ...p };
    }
    // ═══ Fix 2026-07-08: 持久化 Provider 健康數據 ═══
    const providerHealth = {};
    for (const [k, v] of _providerHealth) {
      providerHealth[k] = { ...v };
    }
    const data = {
      version: 3,
      savedAt: Date.now(),
      patterns,
      providerHealth,
      globalStallRate: _globalStallRate,
      globalResponseCount: _globalResponseCount,
      globalStallCount: _globalStallCount,
    };
    fs.mkdirSync(_tuningDir, { recursive: true });
    fs.writeFileSync(_persistPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    log.warn(`⚠️ 保存 tuning 數據失敗: ${e.message}`);
  }
};

// ═══ Debounced 自動保存 ═══
let _saveTimer = null;
const _debouncedSave = () => {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _save();
    _saveTimer = null;
  }, 5000); // 5 秒 debounce
};

// ═══ 行為狀態（持久化） ═══

/** @type {Map<string, {responses: number, stalls: number, completes: number, empties: number, rejects: number, avgLatency: number, lastAction: string, consecutiveStalls: number, promptStyle: string}>} */
const _patterns = new Map();

// 全域行為摘要（跨模型）
let _globalStallRate = 0;
let _globalResponseCount = 0;
let _globalStallCount = 0;

// 當前 prompt 風格（依行為動態切換）
let _currentPromptStyle = "normal"; // "normal" | "strict" | "gentle" | "urgent"

// 當前的停滯檢測敏感度（動態調整）
let _stallSensitivity = 1.0; // 0.5=寬鬆  1.0=正常  1.5=嚴格
let _consecutiveStallThreshold = 2; // 連續幾次停滯後改用更強 prompt

// ═══ Fix 2026-07-08: Provider 感知調優 ═══
// 追蹤提供者（DashScope/Chrome/axios）的可用性，自動跳過已知故障的提供者。
// 與模型級別不同，provider 層面的故障是全局性的（如 DashScope 400）。
// @type {Map<string, {failures: number, lastFailAt: number, cooldownUntil: number, successCount: number}>}
const _providerHealth = new Map();
const PROVIDER_COOLDOWN_MS = 120000; // 故障後冷却 2 分鐘
const PROVIDER_FAIL_THRESHOLD = 3; // 連續 3 次失敗鎖死
const PROVIDER_SUCCESS_RESET = 2; // 連續 2 次成功重置

/**
 * 記錄提供者層級故障（非模型特定）
 * @param {string} provider - "dashscope" | "chrome" | "axios"
 * @param {number} [status] - HTTP 狀態碼
 */
export const recordProviderFailure = (provider, status) => {
  const key = (provider || "unknown").toLowerCase();
  let h = _providerHealth.get(key);
  if (!h) {
    h = { failures: 0, lastFailAt: 0, cooldownUntil: 0, successCount: 0 };
    _providerHealth.set(key, h);
  }
  h.failures++;
  h.lastFailAt = Date.now();
  h.successCount = 0;
  // 連續失敗達到閾值→開啟冷卻
  if (h.failures >= PROVIDER_FAIL_THRESHOLD) {
    h.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    log.warn(
      `🔌 Provider ${key} 連續失敗 ${h.failures} 次，冷卻 ${PROVIDER_COOLDOWN_MS / 1000}s (status=${status})`,
    );
  }
  _debouncedSave();
};

/**
 * 記錄提供者層級成功（重置故障計數）
 * @param {string} provider
 */
export const recordProviderSuccess = (provider) => {
  const key = (provider || "unknown").toLowerCase();
  let h = _providerHealth.get(key);
  if (!h) return;
  h.successCount++;
  if (h.successCount >= PROVIDER_SUCCESS_RESET) {
    h.failures = 0;
    h.cooldownUntil = 0;
    log.info(`🔌 Provider ${key} 已恢復（連續 ${h.successCount} 次成功）`);
  }
  _debouncedSave();
};

/**
 * 檢查提供者是否應跳過（冷卻中）
 * @param {string} provider
 * @returns {boolean}
 */
export const shouldSkipProvider = (provider) => {
  const key = (provider || "unknown").toLowerCase();
  const h = _providerHealth.get(key);
  if (!h) return false;
  if (h.failures < PROVIDER_FAIL_THRESHOLD) return false;
  if (Date.now() < h.cooldownUntil) return true;
  // 冷卻期滿→半開狀態，允許重試
  h.failures = PROVIDER_FAIL_THRESHOLD - 1; // 降一級，下次再失敗就重新計時
  log.info(`🔌 Provider ${key} 冷卻期滿，半開重試`);
  return false;
};

/**
 * 取得提供者健康摘要（供診斷用）
 * @returns {object}
 */
export const getProviderHealth = () => {
  const r = {};
  for (const [k, v] of _providerHealth) {
    r[k] = {
      failures: v.failures,
      cooling: Date.now() < v.cooldownUntil,
      remaining:
        v.cooldownUntil > 0
          ? Math.max(0, Math.round((v.cooldownUntil - Date.now()) / 1000))
          : 0,
      successCount: v.successCount,
    };
  }
  return r;
};

// ═══ 模組初始化：載入持久化數據 ═══
(() => {
  const data = _load();
  if (data) {
    _globalStallRate = data.globalStallRate || 0;
    _globalResponseCount = data.globalResponseCount || 0;
    _globalStallCount = data.globalStallCount || 0;
    if (data.patterns) {
      for (const [model, p] of Object.entries(data.patterns)) {
        _patterns.set(model, p);
      }
    }
    // ═══ Fix 2026-07-08: 載入 Provider 健康數據 ═══
    if (data.providerHealth) {
      for (const [k, v] of Object.entries(data.providerHealth)) {
        _providerHealth.set(k, { ...v });
      }
    }
  }
})();

// ═══ 公開 API ═══

/**
 * 記錄一次模型回應行為
 * @param {string} model - 模型名稱
 * @param {string} action - "stall" | "complete" | "empty" | "reject" | "tool_call"
 * @param {number} [latencyMs=0] - 延遲毫秒
 */
export const recordResponse = (model, action, latencyMs = 0) => {
  // ═══ Fix 2026-07-08: 模型名稱正規化為小寫，避免大小寫不一致導致統計分裂 ═══
  const key = (model || "unknown").toLowerCase();
  let p = _patterns.get(key);
  if (!p) {
    p = {
      responses: 0,
      stalls: 0,
      completes: 0,
      empties: 0,
      rejects: 0,
      avgLatency: 0,
      lastAction: action,
      consecutiveStalls: 0,
      promptStyle: "normal",
    };
    _patterns.set(key, p);
  }

  p.responses++;
  p.lastAction = action;

  // 更新延遲
  if (latencyMs > 0) {
    p.avgLatency =
      p.avgLatency > 0
        ? Math.round(
            (p.avgLatency * (p.responses - 1) + latencyMs) / p.responses,
          )
        : latencyMs;
  }

  // 依行為更新統計
  switch (action) {
    case "stall":
      p.stalls++;
      p.consecutiveStalls++;
      _globalStallCount++;
      break;
    case "complete":
    case "tool_call":
      p.completes++;
      p.consecutiveStalls = 0; // 完成則重置連續停滯
      break;
    case "empty":
      p.empties++;
      p.consecutiveStalls++;
      break;
    case "reject":
      p.rejects++;
      p.consecutiveStalls++;
      break;
  }

  _globalResponseCount++;

  // 根據行為動態調整 prompt 風格
  _adjustPromptStyle(key);

  // ═══ 持久化：debounced 保存 ═══
  _debouncedSave();
};

/**
 * 取得當前適應性 tool prompt（依模型行為動態調整）
 *
 * ═══ Fix 2026-10-18: 從「反覆強調」改為「一次性環境認知」═══
 * 原版每輪注入 urgent/strict 等命令式段落（立即修復/禁止/必須），
 * 與 opencode AGENTS.md 重複，模型被過度指示反而先複述計畫。
 * 現改為：告知環境事實 + 輸出格式規格（proxy 解析器必需），
 * 不重複行為命令；真正的命令只在偵測到停滯時由 stallCorrection
 * 反應式注入一次。
 * @param {Array} tools - 工具定義陣列
 * @param {string} [model] - 當前模型名稱
 * @returns {string|null} 動態 tool prompt，或 null（無工具時）
 */
export const buildAdaptivePrompt = (tools, model) => {
  if (!tools?.length) return null;

  const names = tools.map((t) => t.function?.name || t.name).join(", ");

  // 格式規格：proxy 將 bash-block 轉為 tool_calls，屬協定而非行為命令
  const fmtGuide = [
    "輸出格式（proxy 會解析）：",
    "  bash  → ```bash ... ```（`...` 為佔位符，替換成實際命令，勿照抄）",
    "  read  → ```bash cat /path ```",
    "  write → 直接呼叫 write，或 ``` 檔案內容 ```（無語言標籤；佔位符需替換為實際內容）",
    "  grep  → ```bash grep pattern file ```",
    "  glob  → ```bash find /path -name '*.ts' ```",
    "  edit  → ```bash sed -i 's/old/new/g' file ```",
    "  寫檔禁用 cat/echo 重導向；禁用 `<tool_call>` XML。",
  ].join("\n");

  // 環境認知：陳述事實（身處何處、能力為何），不下達反覆命令
  // ═══ Fix 2026-10-19: 起手式教「先讀須知再動手」+ 修復導向 ═══
  // 實測：模型對話前先鋪陳描述、只執行不修復。改為明確開工順序：
  // 讀專案須知(AGENTS/ARCHITECTURE) → 查前例(lesson/wiki/memory) → 直接改碼落地。
  return [
    "【環境認知】",
    `你運行在 opencode 代理環境，可用工具（裸名直接呼叫，勿加前綴）: ${names}。`,
    "開工順序：動手前先讀專案 AGENTS.md / ARCHITECTURE.md 須知，再用 wiki/lesson/memory 工具查前例（有需要才查）。",
    "修復類任務＝直接修改原始碼落地（write/edit/程式碼區塊），不是只執行命令或描述計畫。",
    "回覆省去前言與計畫複述，直接給動作或結果。",
    fmtGuide,
  ].join("\n");
};

/**
 * 取得當前路由提示
 * @param {string} model - 模型名稱
 * @returns {{level: string, reason: string}|null} 路由調整建議
 */
export const getRoutingHint = (model) => {
  const p = _patterns.get((model || "").toLowerCase());
  if (!p || p.responses < 3) return null;

  const stallRate = p.stalls / p.responses;
  const emptyRate = p.empties / p.responses;

  if (stallRate > 0.5 || emptyRate > 0.3) {
    return {
      level: "downgrade",
      reason: `行爲異常: 停滯率 ${(stallRate * 100).toFixed(0)}%${emptyRate > 0.3 ? `, 空內容率 ${(emptyRate * 100).toFixed(0)}%` : ""}`,
    };
  }

  if (stallRate > 0.3 || emptyRate > 0.15) {
    return {
      level: "caution",
      reason: `行爲不穩定: 停滯率 ${(stallRate * 100).toFixed(0)}%`,
    };
  }

  return null;
};

/**
 * 取得動態化停滯檢查參數
 * @param {string} model - 模型名稱
 * @returns {{threshold: number, sensitivity: number, maxRetries: number}}
 */
export const getStallParams = (model) => {
  const p = _patterns.get((model || "").toLowerCase());
  const base = {
    threshold: parseInt(process.env.STALL_THRESHOLD_MS || "30000"),
    sensitivity: _stallSensitivity,
    maxRetries: parseInt(process.env.MAX_STALL_RETRIES || "2"),
  };

  if (!p || p.responses < 3) return base;

  // 若模型有連續停滯，提高敏感度
  if (p.consecutiveStalls >= 2) {
    return {
      ...base,
      sensitivity: 1.5,
      maxRetries: Math.min(base.maxRetries + 1, 4),
    };
  }

  // 若模型表現良好，降低敏感度避免誤判
  if (p.completes > p.stalls * 3 && p.responses >= 5) {
    return {
      ...base,
      sensitivity: 0.7,
      maxRetries: Math.max(base.maxRetries - 1, 1),
    };
  }

  return base;
};

/**
 * 根據模型行為調整對應的矯正提示
 * @param {string} model
 * @param {number} retryCount - 目前第幾次重試（0-based）
 * @returns {string} 矯正訊息
 */
export const getCorrectionMessage = (model, retryCount) => {
  const p = _patterns.get((model || "").toLowerCase());
  const consecutive = p?.consecutiveStalls || 0;

  if (retryCount >= 2 || consecutive >= 3) {
    return [
      "===== 請修復 =====",
      "請直接輸出 write 工具、edit 工具或可落地的程式碼，不要只說要做什麼。",
      "範例:",
      "  ```",
      "  export const x = 1",
      "  ```",
      "  ```bash",
      "  bun run src/index.ts",
      "  ```",
      "===== 請修復 =====",
    ].join("\n");
  }

  if (retryCount >= 1 || consecutive >= 2) {
    return [
      "===== 請修復 =====",
      "請直接輸出 write / edit / read 或可落地的程式碼。",
      "範例:",
      "  ```",
      "  export const x = 1",
      "  ```",
      "  ```bash",
      "  bun run src/index.ts",
      "  ```",
      "===== 請修復 =====",
    ].join("\n");
  }

  return [
    "===== 請修復 =====",
    "請直接輸出 write / edit / read 或可落地的程式碼。",
    "範例: 先讀取檔案，再輸出修改內容或程式碼區塊。",
  ].join("\n");
};

/**
 * 根據模型歷史行為提供動態超時建議（速度優化）
 * 慢速模型 → 放寬 timeout 避免誤殺
 * 快速模型 → 縮短 timeout 提升用戶體驗
 *
 * @param {string} model - 模型名稱
 * @param {number} [defaultTimeout=120000] - 預設超時 ms
 * @returns {number} 建議的超時毫秒數
 */
export const getTimeoutMs = (model, defaultTimeout = 120000) => {
  const p = _patterns.get((model || "").toLowerCase());
  if (!p || p.responses < 3) return defaultTimeout;

  // 若模型有近期高延遲，適當放寬
  const hasStallHistory = p.stalls > 0 || p.empties > 0;
  const recentAvg = p.avgLatency;

  // 模型平均延遲 <10s 且無異常 → 縮短 timeout 加速回饋
  if (
    recentAvg < 10000 &&
    !hasStallHistory &&
    p.completes > p.responses * 0.8
  ) {
    return Math.round(defaultTimeout * 0.7); // 縮短 30%
  }

  // 模型平均延遲 >45s 或有大量停滯 → 放寬 timeout
  if (recentAvg > 45000 || p.stalls > p.responses * 0.3) {
    return Math.round(defaultTimeout * 1.4); // 放寬 40%
  }

  // 模型平均延遲 25-45s → 適度放寬
  if (recentAvg > 25000) {
    return Math.round(defaultTimeout * 1.2);
  }

  return defaultTimeout;
};

/**
 * 重置特定模型的追蹤數據（供測試用）
 */
export const resetModel = (model) => {
  _patterns.delete((model || "").toLowerCase());
};

/**
 * 取得目前所有模型的追蹤統計
 */
export const getStats = () => {
  const out = [];
  for (const [model, p] of _patterns) {
    out.push({
      model,
      responses: p.responses,
      stallRate: p.responses > 0 ? +(p.stalls / p.responses).toFixed(3) : 0,
      emptyRate: p.responses > 0 ? +(p.empties / p.responses).toFixed(3) : 0,
      avgLatency: p.avgLatency,
      consecutiveStalls: p.consecutiveStalls,
      promptStyle: p.promptStyle,
    });
  }
  return out.sort((a, b) => b.responses - a.responses);
};

// ═══ Fix 2026-07-09: 跨裝置健康數據同步 ═══
// 本地（筆電）定時推送健康數據至主機（主力機），主機接收後合併存入。
// 合併策略：計數累加、延遲加權平均、風格取較嚴格、provider 取較嚴重狀態。

const _STYLE_RANK = { gentle: 0, normal: 1, strict: 2, urgent: 3 };

/**
 * 匯出當前健康數據（供推送用）
 * @returns {object} 可 JSON 序列化的健康快照
 */
export const exportHealth = () => {
  const patterns = {};
  for (const [m, p] of _patterns) patterns[m] = { ...p };
  const providerHealth = {};
  for (const [k, v] of _providerHealth) providerHealth[k] = { ...v };
  return {
    version: 3,
    syncedAt: Date.now(),
    host: process.env.DEVICE_ROLE || "unknown",
    patterns,
    providerHealth,
    globalStallRate: _globalStallRate,
    globalResponseCount: _globalResponseCount,
    globalStallCount: _globalStallCount,
  };
};

/**
 * 合併遠端推送的健康數據（主機接收後呼叫）
 * @param {object} remote - exportHealth() 的輸出
 * @returns {number} 合併的模型數量
 */
export const mergeHealth = (remote) => {
  if (!remote || typeof remote !== "object") return 0;
  let merged = 0;

  // 1) 合併模型行為模式
  if (remote.patterns && typeof remote.patterns === "object") {
    for (const [m, rp] of Object.entries(remote.patterns)) {
      const lp = _patterns.get(m);
      if (!lp) {
        _patterns.set(m, { ...rp });
        merged++;
        continue;
      }
      // 計數累加
      const rSum = rp.responses || 0;
      const lSum = lp.responses || 0;
      const tot = rSum + lSum;
      // 加權平均延遲
      lp.avgLatency =
        tot > 0
          ? Math.round(
              ((lp.avgLatency || 0) * lSum + (rp.avgLatency || 0) * rSum) / tot,
            )
          : lp.avgLatency;
      lp.responses = tot;
      lp.stalls = (lp.stalls || 0) + (rp.stalls || 0);
      lp.completes = (lp.completes || 0) + (rp.completes || 0);
      lp.empties = (lp.empties || 0) + (rp.empties || 0);
      lp.rejects = (lp.rejects || 0) + (rp.rejects || 0);
      // 連續停滯取較悲觀（max）
      lp.consecutiveStalls = Math.max(
        lp.consecutiveStalls || 0,
        rp.consecutiveStalls || 0,
      );
      // prompt 風格取較嚴格
      const lr = _STYLE_RANK[lp.promptStyle] ?? 1;
      const rr = _STYLE_RANK[rp.promptStyle] ?? 1;
      lp.promptStyle = lr >= rr ? lp.promptStyle : rp.promptStyle;
      merged++;
    }
  }

  // 2) 合併 provider 健康（取較嚴重狀態）
  if (remote.providerHealth && typeof remote.providerHealth === "object") {
    for (const [k, rv] of Object.entries(remote.providerHealth)) {
      const lv = _providerHealth.get(k);
      if (!lv) {
        _providerHealth.set(k, { ...rv });
        continue;
      }
      lv.failures = Math.max(lv.failures || 0, rv.failures || 0);
      lv.successCount = Math.min(lv.successCount || 0, rv.successCount || 0);
      lv.cooldownUntil = Math.max(lv.cooldownUntil || 0, rv.cooldownUntil || 0);
      lv.lastFailAt = Math.max(lv.lastFailAt || 0, rv.lastFailAt || 0);
    }
  }

  // 3) 全域摘要取較高計數（保守）
  if (remote.globalResponseCount) {
    _globalResponseCount = Math.max(
      _globalResponseCount,
      remote.globalResponseCount,
    );
  }
  if (remote.globalStallCount) {
    _globalStallCount = Math.max(_globalStallCount, remote.globalStallCount);
  }

  _debouncedSave();
  log.info(
    `🔄 已合併遠端健康數據: ${merged} 模型 (from ${remote.host || "?"})`,
  );
  return merged;
};

export const getCurrentStyle = () => _currentPromptStyle;

/**
 * 強制立即保存（供 shutdown 時呼叫）
 */
export const flush = () => {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  _save();
  log.info("💾 tuning 數據已強制保存");
};

/**
 * 取得持久化路徑（供除錯用）
 */
export const getPersistPath = () => _persistPath;

// ═══ 停滯恢復計數器（防止負向迴圈死鎖） ═══
// 當 urgent/strict 連續生效但無改善，強制恢復 normal 打破死鎖
const _STALL_RECOVERY_AFTER = 6; // urgent/strict 持續此數量回應無改善 → 降回 normal

/**
 * 根據模型行為動態調整 prompt 風格
 */
const _adjustPromptStyle = (key) => {
  const p = _patterns.get(key);
  if (!p || p.responses < 2) return;

  const stallRate = p.stalls / p.responses;
  const emptyRate = p.empties / p.responses;
  const abnormalRate = (p.stalls + p.empties) / p.responses;

  // ═══ Fix 2026-07-08: 打破負向迴圈 — 若 urgent/strict 已持續 N 次無改善 ═══
  // 連續停滯時 prompt 越來越急迫 → 模型更跳過思考 → 更停滯
  // 檢測：promptStyle 為 urgent/strict，且最近 N 次全為 stall/empty
  if (
    (p.promptStyle === "urgent" || p.promptStyle === "strict") &&
    p.responses >= _STALL_RECOVERY_AFTER
  ) {
    // 檢查最近 _STALL_RECOVERY_AFTER 次回應是否全異常
    // 使用 consecutiveStalls 判斷：若已累積超過 _STALL_RECOVERY_AFTER 次未完成
    if (p.consecutiveStalls >= _STALL_RECOVERY_AFTER) {
      log.warn(
        `🔄 [${key}] prompt 風格恢復: ${p.promptStyle} → normal` +
          ` (連續 ${p.consecutiveStalls} 次異常，打破負向迴圈)`,
      );
      p.promptStyle = "normal";
      p.consecutiveStalls = 0; // 重置計數器
      // 同時降低敏感度讓模型有喘息空間
      _stallSensitivity = Math.max(_stallSensitivity - 0.2, 0.7);
      return;
    }
  }

  // 決定 prompt 風格
  let newStyle;
  if (p.consecutiveStalls >= 3) {
    newStyle = "urgent";
  } else if (abnormalRate > 0.6 || stallRate > 0.4) {
    newStyle = "urgent";
  } else if (abnormalRate > 0.4 || stallRate > 0.25) {
    newStyle = "strict";
  } else if (abnormalRate > 0.15) {
    newStyle = "normal";
  } else {
    newStyle = "normal"; // 表現好也用 normal，不要一直用 strict
  }

  // ═══ Fix: 只更新 per-model 風格，全域 _currentPromptStyle 僅作初始預設 ═══
  // 舊行為：_currentPromptStyle 因單一模型行為改變，影響所有無資料的新模型
  // 新行為：每個模型獨立追蹤，新模型一律從 normal 開始
  if (newStyle !== p.promptStyle) {
    log.info(
      `🎛️  [${key}] prompt 風格: ${p.promptStyle} → ${newStyle}` +
        ` (停滯率 ${(stallRate * 100).toFixed(0)}%/空內容 ${(emptyRate * 100).toFixed(0)}%)`,
    );
    p.promptStyle = newStyle;
  }

  // 同步更新敏感度
  if (abnormalRate > 0.4) {
    _stallSensitivity = Math.min(_stallSensitivity + 0.1, 1.5);
  } else if (abnormalRate < 0.1 && _stallSensitivity > 1.0) {
    _stallSensitivity = Math.max(_stallSensitivity - 0.1, 0.7);
  }

  // 根據全域行為調整參數
  if (_globalResponseCount > 0) {
    _globalStallRate = _globalStallCount / _globalResponseCount;
  }
};

// ═══ 進程退出時強制保存 ═══
// 避免進程意外終止時遺失 tuning 數據
process.on("exit", () => {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  try {
    _save();
  } catch (_) {}
});
process.on("SIGINT", () => {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  try {
    _save();
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
});
process.on("SIGTERM", () => {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  try {
    _save();
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
});
