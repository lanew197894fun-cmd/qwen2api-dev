// Telegram Memory Bridge — store.ts
// 本地記憶/知識/維基的檔案操作層

import type {
  MemEntry,
  MemFile,
  StoreResult,
  RecallResult,
  SyncState,
} from "./types.ts";
import { resolve, dirname } from "path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  stat,
  rename,
  unlink,
} from "fs/promises";
import { existsSync } from "fs";
import { hostname } from "os";
import { createHash } from "crypto";
import {
  recordApiCall,
  startCall,
  endCall,
  setQueueDepth,
  suggest,
} from "./governor.ts";
import { LESSON_DIR } from "../../config/paths.js";

/** 記憶內容雜湊（摘要+分類+標籤）→ 用於冪等性去重 */
function contentHash(
  summary: string,
  category: string,
  tags: string[],
): string {
  return createHash("md5")
    .update(`${summary.trim()}|${category}|${[...tags].sort().join(",")}`)
    .digest("hex");
}

const CHAT_URL =
  process.env.CHAT_URL || "http://127.0.0.1:3000/v1/chat/completions";

/**
 * 從上游 chat/completions 回應取出文字內容。
 *
 * 修復（2026-10-25）：上游在長 prompt／併發超載時會回 200 但
 * `choices[0].message.content = null`（實測 38K~42K tokens 必現），
 * 或 choices 為空陣列。原實作直接 `data.choices[0].message.content`
 * 回傳 null → 呼叫端 `answer.length` 拋
 * `null is not an object (evaluating 'answer.length')` → /ask 整段失敗。
 * 此處一律驗證並轉為可辨識的錯誤，讓上層走重試／降級而非崩潰。
 */
function pick(data: unknown): string {
  const d = data as { choices?: { message?: { content?: unknown } }[] };
  const c = d?.choices?.[0]?.message?.content;
  if (typeof c !== "string" || !c.trim())
    throw new Error("upstream_empty_content: 上游回覆內容為空");
  return c;
}

function getApiKey(): string {
  const key = process.env.API_KEY;
  if (!key) {
    console.error("❌ API_KEY 未設定（Qwen proxy 認證用）");
    console.error("   可在 .env 設定 API_KEY 或在環境變數中設定");
    process.exit(1);
  }
  return key;
}

// ── Concurrency semaphore ──
// Limits parallel Qwen API calls based on governor's maxConc
// Dynamically adjusts as governor detects load changes
let semActive = 0;
const semQueue: Array<{ id: number; cb: () => void }> = [];
let semLastLog = 0;
let semNextId = 0;

async function semAcquire(timeoutMs?: number): Promise<void> {
  const { maxConc } = suggest();
  setQueueDepth(semQueue.length);
  if (semActive < maxConc) {
    semActive++;
    return;
  }
  // Log queue state every 5s when waiting
  const now = Date.now();
  if (now - semLastLog > 5000) {
    semLastLog = now;
    console.log(
      `[semaphore] ⏳ waiting: ${semQueue.length + 1}, active: ${semActive}, maxConc: ${maxConc}`,
    );
  }

  // 🐛 FIX: 使用 AbortController + 唯一 ID 防止懸空 callback
  // 每個請求有唯一 ID，semRelease 只執行有效 ID 的 callback
  // 關鍵：callback 不增加 semActive，它接管釋放者的 slot
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acquired = false;
  const myId = ++semNextId;
  let cb: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      cb = () => {
        clearTimeout(timer);
        if (ac.signal.aborted) return;
        acquired = true;
        // 不增加 semActive：接管釋放者的 slot
        resolve();
      };
      semQueue.push({ id: myId, cb: cb! });
      if (timeoutMs) {
        timer = setTimeout(() => {
          ac.abort();
          const idx = semQueue.findIndex((item) => item.id === myId);
          if (idx >= 0) semQueue.splice(idx, 1);
          reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  } finally {
    clearTimeout(timer);
    ac.abort();
    // 確保 semActive 正確性：只有在成功獲取後才增加
    if (!acquired) {
      // 獲取失敗，從佇列中移除 callback
      const idx = semQueue.findIndex((item) => item.id === myId);
      if (idx >= 0) semQueue.splice(idx, 1);
    }
  }
}

function semRelease(): void {
  // 只執行有效的 callback（未被 timeout 移除的）
  // callback 接管 slot，semActive 保持不變
  while (semQueue.length > 0) {
    const next = semQueue.shift();
    if (next) {
      next.cb();
      return;
    }
  }
  // 沒有等待者，真正釋放 slot
  semActive--;
  setQueueDepth(semQueue.length);
}

/** 硬性超時保護，確保不會無限等待（預設 60s，適應 Max 模型推理） */
const HARD_TIMEOUT_MS = Number(process.env.QWEN_HARD_TIMEOUT_MS) || 60000;

function requestTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms),
  );
}

// ── 檢索輔助（模組層，供 searchByModel / recall 共用）──

/** 送進模型的候選記憶上限（控制 prompt 大小，避免超出 context） */
const CANDIDATE_MAX = 40;

/** 帶分數的記憶（供檢索流程內部流轉） */
type ScoredEntry = {
  id: string;
  score: number;
  summary: string;
  tags: string[];
  category: string;
  importance?: number;
  created?: string;
  device?: string;
};

/** 關鍵字切詞：中文以字元 bigram + 英文單詞，兼顧中英混合查詢 */
function tokenize(q: string): string[] {
  const raw = q
    .toLowerCase()
    .split(/[\s,，。、；;：:!?！？「」『』"'()（）\[\]{}]+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const w of raw) {
    out.add(w);
    // 中文詞：連續 CJK 取 bigram（單字則保留原字）
    const cjk = w.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const seg of cjk)
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 單一查詢詞的最大加權命中（摘要 0.3 + 前綴 0.2 + 標籤 0.5 + 分類 0.4） */
const MAX_WORD_WEIGHT = 1.4;

/**
 * 關鍵字分數排序（摘要 0.3 / 標籤 0.5 / 分類 0.4 三層加權 × IDF 詞權重）。
 *
 * IDF：稀有詞（如「lancedb」）權重高，常見詞（如「記憶」「telegram」）權重低。
 * 避免所有命中同一常見詞的記憶都拿到相同分數而失去區辨度。
 */
function rankByKeyword(
  entries: MemEntry[],
  query: string,
  limit: number,
): ScoredEntry[] {
  const words = tokenize(query);
  if (words.length === 0) return [];
  const n = entries.length;
  // 文件頻率 → IDF 權重
  const df = new Map<string, number>();
  for (const e of entries) {
    const s = e.summary.toLowerCase();
    const tags = e.tags.map((t) => t.toLowerCase());
    for (const w of words) {
      const hit =
        s.includes(w) ||
        tags.some((t) => t.includes(w)) ||
        e.category === w ||
        e.category.includes(w);
      if (hit) df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  let ceiling = 0;
  for (const w of words) {
    const weight = Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1;
    idf.set(w, weight);
    ceiling += weight * MAX_WORD_WEIGHT;
  }
  if (ceiling <= 0) return [];
  return entries
    .map((e) => {
      const s = e.summary.toLowerCase();
      const head = s.slice(0, 80);
      const tags = e.tags.map((t) => t.toLowerCase());
      let raw = 0;
      for (const w of words) {
        const weight = idf.get(w)!;
        if (s.includes(w)) raw += weight * 0.3;
        // 前綴命中加成（開頭即提及者通常更重要）→ 提供排序區辨度
        if (head.includes(w)) raw += weight * 0.2;
        if (tags.some((t) => t.includes(w))) raw += weight * 0.5;
        if (e.category === w || e.category.includes(w)) raw += weight * 0.4;
      }
      return {
        id: e.id,
        // 絕對相關度 = 命中權重 / 全部詞最大權重 → 意義為「命中幾成的查詢詞」
        score: Math.min(Number((raw / ceiling).toFixed(4)), 1),
        summary: e.summary,
        tags: e.tags,
        category: e.category,
        importance: e.importance,
        created: e.created,
        device: e.device || "unknown",
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || b.importance! - a.importance!)
    .slice(0, limit);
}

/** 無關鍵字命中時的候選：取最近且重要度高的記憶作為背景（僅供模型評分用） */
function recentByImportance(entries: MemEntry[], limit: number): ScoredEntry[] {
  return [...entries]
    .sort(
      (a, b) =>
        b.importance - a.importance || b.created.localeCompare(a.created),
    )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      score: e.importance,
      summary: e.summary,
      tags: e.tags,
      category: e.category,
      importance: e.importance,
      created: e.created,
      device: e.device || "unknown",
    }));
}

export class MemStore {
  private root: string;
  private _indexPath: string;
  private entriesDir: string;
  private syncStatePath: string;
  private qwenModel: string;
  /** 序列化 appendIndex 寫入，避免併發 race condition */
  private appendLock = Promise.resolve();

  constructor(root: string, qwenModel?: string) {
    this.root = resolve(root);
    this.entriesDir = resolve(this.root, "entries");
    this._indexPath = resolve(this.root, "memory-index.json");
    this.syncStatePath = resolve(this.root, "sync-state.json");
    this.qwenModel = qwenModel || "small";
  }

  // ── Init ──

  async init(): Promise<void> {
    await mkdir(this.entriesDir, { recursive: true });
  }

  // ── Qwen chat ──

  getModel(): string {
    return this.qwenModel;
  }

  setModel(m: string): void {
    this.qwenModel = m;
  }

  /** 判斷訊息是否極簡（供 overload 時跳過 AI） */
  private isTrivial(msg: string): boolean {
    const t = msg.trim();
    if (t.length > 60) return false;
    const trivia = [
      "好",
      "ok",
      "okay",
      "是的",
      "沒錯",
      "謝謝",
      "感恩",
      "了解",
      "知道了",
      "明白",
      "收到",
    ];
    if (trivia.includes(t.toLowerCase())) return true;
    if (/^[👍👌✅🙏😊❤️]+$/.test(t)) return true;
    return false;
  }

  /** 模型等級 → 具體模型名稱（proxy 會再依複雜度路由） */
  private modelForTier(tier: "small" | "medium" | "large"): string {
    // 讓 chat-proxy 做最終路由，我們只給 hint
    // 2026-10-25 Fix：small 原寫 "qwen3.6-27b"，上游 31 個模型清單查無此 id
    // → 快速通道每次都先撞 404 才降級，白等一輪。改用現存的 flash。
    const map: Record<string, string> = {
      small: "qwen3.8-omni-flash",
      medium: "qwen3.7-plus",
      large: this.qwenModel, // 使用者設定的主模型
    };
    return map[tier] || this.qwenModel;
  }

  async qwenAsk(system: string, userMsg: string): Promise<string> {
    // 先查 governor 狀態決定策略
    const gov = suggest();

    // 動態思考等級：根據訊息長度與複雜度調整，避免簡單問題浪費時間
    const hasComplexKeywords = /分析|為什麼|如何|代碼|debug|優化|架構|計算|解釋/i.test(userMsg);
    const dynamicReasoningEffort: "none" | "low" | "medium" | "high" = 
      hasComplexKeywords || userMsg.length > 200 ? "medium" : 
      userMsg.length > 50 ? "low" : "none";

    // 極高負載 + 極簡訊息 → 跳過 AI，直接回確認（附 governor 狀態）
    if (gov.skipAIfIfTrivial && this.isTrivial(userMsg)) {
      console.log(`[qwen:skip] ${gov.info}`);
      return `⚡ 系統負載較高，已跳過 AI 回應 (${gov.info})`;
    }

    // 根據 governor 決定 timeout 與模型
    const isSmall = gov.modelTier === "small";
    // small tier 且非複雜問題 → 走快速通道（跳 semaphore）
    const useFastPath =
      isSmall &&
      !userMsg.includes("```") &&
      !userMsg.includes("~~~") &&
      userMsg.length <= 200;

    if (useFastPath) {
      const t0 = performance.now();
      const model = this.modelForTier("small");
      try {
        const res = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userMsg },
            ],
            max_tokens: 256,
            temperature: 0.3,
            // 動態思考等級：根據訊息複雜度調整，避免簡單問題浪費時間
            reasoning_effort: dynamicReasoningEffort,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices: { message: { content: string } }[];
          };
          const elapsed = performance.now() - t0;
          console.log(
            `[qwen:fast] ${model} ${Math.round(elapsed)}ms (${gov.info})`,
          );
          return pick(data);
        }
        console.warn(`[qwen:fast] ${res.status} → 降級`);
      } catch (e) {
        console.warn(`[qwen:fast] ${(e as Error).message} → 降級`);
      }
    }

    // 正常通道（受 governor 動態控制）
    // P0 修復：semaphore 在入隊/出隊時呼叫，超時時優先釋放 slot 而非阻塞
    let acquired = false;
    let semTimeoutInfo = "";
    try {
      const semStart = performance.now();
      await semAcquire(HARD_TIMEOUT_MS);
      acquired = true;
      const semDur = performance.now() - semStart;
      if (semDur > 8000) {
        semTimeoutInfo = ` (sem-wait ${Math.round(semDur)}ms)`;
      }
    } catch (e) {
      // Semaphore 超時 → 系統過載，降級為告知使用者
      // 關鍵：確保 semActive 正確歸零，避免後續請求永久阻塞
      console.warn(
        `[qwen] Semaphore timeout, downgrading: ${(e as Error).message}`,
      );
      // 強制釋放 semaphore slot
      semRelease();
      return `⏳ 系統忙碌中，請求已排入佇列 (${gov.info}${semTimeoutInfo})`;
    }

    startCall();
    const t0 = performance.now();
    let ok = true;

    // 動態超時：模型越小超時越短
    const timeoutMs =
      gov.modelTier === "small"
        ? 15000
        : gov.modelTier === "medium"
          ? 30000
          : gov.skipBg
            ? 60000
            : 45000;
    const maxRetries = gov.modelTier === "small" ? 0 : 1; // 減少重試次數以快速失敗
    const model = this.modelForTier(gov.modelTier);

    // 🐛 FIX: Promise.race 懸空修復 — 使用 AbortController 取消背景 fetch
    // 防止超時時 fetchWithRetry 仍在背景執行造成 unhandled rejection
    const ctrl = new AbortController();
    try {
      const fetchPromise = this.fetchWithRetry(
        model,
        system,
        userMsg,
        timeoutMs,
        maxRetries,
        gov,
        dynamicReasoningEffort,
        ctrl.signal,
      );
      const result = await Promise.race([
        fetchPromise,
        requestTimeout(timeoutMs + 5000), // 給予 fetchWithRetry 額外緩衝時間
      ]);
      ctrl.abort(); // fetch 勝出，取消 timeout（無作用，僅確保狀態一致）
      fetchPromise.catch(() => {}); // 吞掉被遺棄 promise 的 rejection，防 unhandled rejection
      const elapsed = performance.now() - t0;
      console.log(`[qwen] ${model} ${Math.round(elapsed)}ms (${gov.info})`);
      let resultStr = result as string;
      // 減少模型回覆顯示，避免刷屏 (限制在 3000 字元以內)
      if (resultStr.length > 3000) {
        resultStr = resultStr.slice(0, 3000) + "\n\n... (回覆過長，已截斷以避免刷屏)";
      }
      return resultStr;
    } catch (e) {
      ctrl.abort(); // timeout 勝出，取消背景 fetch 釋放資源
      ok = false;
      const errMsg = (e as Error).message;
      console.error(`[qwen] Failed: ${errMsg} (gov: ${gov.info})`);
      // 優化：若為 semaphore timeout，提供更明確的使用者訊息
      if (errMsg.includes("Semaphore") || errMsg.includes("semaphore")) {
        throw new Error(`⏳ 系統負載高峰，請稍後重試 [${gov.info}]`);
      }
      throw new Error(`${errMsg} [${gov.info}]`);
    } finally {
      if (acquired) semRelease();
      endCall();
      recordApiCall(performance.now() - t0, ok);
    }
  }

  private async fetchWithRetry(
    model: string,
    system: string,
    userMsg: string,
    timeoutMs: number,
    maxRetries: number,
    gov: ReturnType<typeof suggest>,
    reasoningEffort: "none" | "low" | "medium" | "high",
    externalSignal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 🐛 FIX: 合併外部 signal（用於 AbortController 取消）與內部 timeout
        const signal = externalSignal
          ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        const res = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userMsg },
            ],
            max_tokens: gov.modelTier === "small" ? 256 : 1024,
            temperature: 0.3,
            // 動態思考等級：根據訊息複雜度調整，避免簡單問題浪費時間
            reasoning_effort: reasoningEffort,
          }),
          signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          // 嘗試解析錯誤回應中的具體錯誤訊息
          let detail = "";
          try {
            const errBody = JSON.parse(txt);
            detail =
              errBody.error?.message ||
              errBody.error?.toString() ||
              errBody.choices?.[0]?.message?.content ||
              "";
          } catch {
            detail = txt.slice(0, 200);
          }
          if (res.status >= 500 && attempt < maxRetries) {
            const wait = Math.min(1000 * 2 ** attempt, 5000);
            console.warn(
              `[qwen] ${res.status} 重試 ${attempt + 1}/${maxRetries}，等待 ${wait}ms`,
            );
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          const errMsg = `qwen error ${res.status}${detail ? `: ${detail}` : ""}`;
          console.error(`[qwen] ${errMsg}`);
          throw new Error(errMsg);
        }
        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        return pick(data);
      } catch (e) {
        // 🐛 FIX: 外部已 abort → 直接拋出，不浪費時間重試
        if (externalSignal?.aborted) throw e;
        if (attempt < maxRetries) {
          const wait = Math.min(1000 * 2 ** attempt, 5000);
          console.warn(
            `[qwen] ${(e as Error).message} 重試 ${attempt + 1}/${maxRetries}，等待 ${wait}ms`,
          );
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw new Error("qwenAsk: all retries exhausted");
  }

  // ── Model-powered search ──

  /**
   * 語意檢索：本地關鍵字預篩 → 候選送模型評分。
   *
   * P0 修復（2026-10-21）：原實作把「全部記憶」（3670 筆 / 795K 字元 ≈ 497K tokens）
   * 送進模型，必然超出 context → 每次呼叫必定失敗且背景記憶恆為空。
   * 新流程：先以關鍵字分數撈出有限候選（上限 CANDIDATE_MAX），模型僅評分候選。
   * 模型失敗（尖峰 503 / 超時）時降級為關鍵字分數結果，不再回傳空集合。
   */
  async searchByModel(query: string, limit = 10): Promise<RecallResult> {
    const all = await this.list();
    if (all.length === 0) return { entries: [], total: 0 };

    // 1. 本地預篩：只撈關鍵字有命中的（明確搜尋不可回傳無關記憶）
    const candidates = rankByKeyword(all, query, CANDIDATE_MAX);
    if (candidates.length === 0) return { entries: [], total: all.length };

    // 2. 送模型評分（僅候選，prompt 有界）
    const memoryList = candidates
      .map(
        (e, i) =>
          `[${i}] ID: ${e.id}\n  摘要: ${e.summary}\n  分類: ${e.category}\n  標籤: ${e.tags.join(", ")}`,
      )
      .join("\n\n");

    const system =
      "你是記憶檢索助手。對每筆記憶評分其與查詢的相關度（0-100），0=無關，100=完全相關。" +
      '只回傳 JSON 陣列，格式：[{"index": 0, "score": 85, "reason": "簡短原因"}]。' +
      `最多 ${limit} 筆，優先回傳高分者。不足 ${limit} 筆也沒關係，不要硬湊。`;

    const prompt = [`查詢: ${query}`, "", "記憶列表:", memoryList].join("\n");

    try {
      const answer = await this.qwenAsk(system, prompt);
      const parsed = JSON.parse(answer) as {
        index: number;
        score: number;
        reason: string;
      }[];
      const scored = parsed
        .filter(
          (p) => p.index >= 0 && p.index < candidates.length && p.score > 0,
        )
        .map((p) => {
          const e = candidates[p.index];
          return {
            ...e,
            score: Math.round(p.score) / 100,
            reason: p.reason || "",
            device: e.device || "unknown",
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) return { entries: scored, total: all.length };
    } catch {
      // 降級：模型不可用（尖峰 503 / 超時）→ 改用關鍵字分數
    }

    // 3. 降級路徑：關鍵字分數結果
    return {
      entries: candidates.slice(0, limit).map((e) => ({
        ...e,
        device: e.device || "unknown",
      })),
      total: all.length,
    };
  }

  // ── Store ──

  async store(
    summary: string,
    opts?: {
      category?: string;
      importance?: number;
      tags?: string[];
      content?: string;
    },
  ): Promise<StoreResult> {
    // 防止 summary 超過 API 允許長度（1000 UTF-16 code units）
    summary = truncToJSLen(summary, 1000);
    const cat = opts?.category ?? inferCategory(summary);
    const imp = opts?.importance ?? 0.7;
    const tags = opts?.tags ?? inferTags(summary);
    const content = opts?.content ?? summary;
    const device = getDeviceName();

    // 🐛 FIX 冪等性（2026-10-21）：同內容重複寫入曾讓 3670 筆記憶只剩 60 筆不重複
    // → 檢索結果全被同內容灌水、相關度失去區辨度。
    // 以「摘要+分類+標籤」雜湊比對，命中則跳過寫入。
    const digest = contentHash(summary, cat, tags);
    const existing = await this.findByHash(digest);
    if (existing) {
      return { id: existing.id, path: "", synced: false, skipped: true };
    }

    const id = `mem-${Date.now()}-${slugify(summary)}`;

    const frontmatter = [
      "---",
      `category: ${cat}`,
      `created: ${new Date().toISOString()}`,
      `importance: ${imp}`,
      `tags: [${tags.join(", ")}]`,
      `device: ${device}`,
      "---",
      "",
      content,
    ].join("\n");

    const path = resolve(this.entriesDir, `${id}.md`);
    await writeFile(path, frontmatter, "utf-8");

    // update index
    await this.appendIndex({
      id,
      category: cat as any,
      created: new Date().toISOString(),
      importance: imp,
      tags,
      summary,
      device,
    });

    return { id, path, synced: false };
  }

  // ── Recall / Search ──

  async recall(query: string, limit = 10): Promise<RecallResult> {
    const entries = await this.list();
    const scored = rankByKeyword(entries, query, limit);
    return { entries: scored, total: entries.length };
  }

  /**
   * 背景記憶：給 AI 回答當上下文用。
   *
   * P0 效能修復（2026-10-21）：原本 bot 每則訊息都呼叫 searchByModel 取背景，
   * 每次多花一次模型呼叫（10~15 秒）且回傳結果多半是空（模型評分常失敗）。
   * 背景記憶「只需相關、不需精準排序」→ 純本地關鍵字檢索即可，零模型成本、<30ms。
   */
  async contextMemories(query: string, limit = 3): Promise<string> {
    const entries = await this.list();
    if (entries.length === 0) return "";
    const scored = rankByKeyword(entries, query, limit);
    const picked =
      scored.length > 0 ? scored : recentByImportance(entries, limit);
    return picked
      .map((e, i) => `[背景 ${i + 1}] ${truncToJSLen(e.summary, 200)}`)
      .join("\n");
  }

  /** P0 修復：依 ID 精確查詢記憶（供冪等性檢查使用） */
  async recallById(id: string): Promise<MemEntry | null> {
    const entries = await this.list();
    return entries.find((e) => e.id === id) || null;
  }

  async searchByTag(tag: string): Promise<MemEntry[]> {
    const entries = await this.list();
    return entries.filter((e) =>
      e.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
    );
  }

  /** 內容雜湊比對：找到相同摘要+分類+標籤的既有記憶（冪等性檢查） */
  private async findByHash(digest: string): Promise<MemEntry | null> {
    const entries = await this.list();
    for (const e of entries) {
      if (contentHash(e.summary, e.category, e.tags) === digest) return e;
    }
    return null;
  }

  // ── List ──

  async list(): Promise<MemEntry[]> {
    if (!existsSync(this.indexPath)) return [];
    const raw = await readFile(this.indexPath, "utf-8");
    return JSON.parse(raw) as MemEntry[];
  }

  // ── Stats ──

  async stats(): Promise<{
    total: number;
    byCategory: Record<string, number>;
    byImportance: { high: number; mid: number; low: number };
    lastSync?: string;
  }> {
    const entries = await this.list();
    const byCategory: Record<string, number> = {};
    let high = 0,
      mid = 0,
      low = 0;
    for (const e of entries) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      if (e.importance >= 0.8) high++;
      else if (e.importance >= 0.5) mid++;
      else low++;
    }
    const syncState = await this.readSyncState();
    return {
      total: entries.length,
      byCategory,
      byImportance: { high, mid, low },
      lastSync: syncState.lastSync,
    };
  }

  // ── Read entry content ──

  async readContent(id: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const p = resolve(this.entriesDir, `${id}.md`);
    if (!p.startsWith(this.entriesDir)) return null;
    if (!existsSync(p)) return null;
    return readFile(p, "utf-8");
  }

  // ── Sync state ──

  async readSyncState(): Promise<SyncState> {
    if (!existsSync(this.syncStatePath)) return { lastSync: "", syncedIds: [] };
    return JSON.parse(await readFile(this.syncStatePath, "utf-8"));
  }

  async writeSyncState(state: SyncState): Promise<void> {
    await writeFile(
      this.syncStatePath,
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  }

  // ── Helpers ──

  private async appendIndex(entry: MemEntry): Promise<void> {
    // 序列化寫入：避免兩次併發 store() 同時讀取舊索引後互相覆蓋
    return new Promise<void>((resolve, reject) => {
      this.appendLock = this.appendLock.then(async () => {
        try {
          await this._appendIndex(entry);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private async _appendIndex(entry: MemEntry): Promise<void> {
    // 跨裝置同步衝突解決：讀取最新內容後合併，避免覆蓋
    const existing = await this.list();
    if (existing.some((e) => e.id === entry.id)) return;

    const tmp = this.indexPath + ".tmp." + process.pid;
    try {
      // 寫入新資料到暫存檔
      const newData = [...existing, entry];
      await writeFile(tmp, JSON.stringify(newData, null, 2), "utf-8");

      // 原子性替換
      await rename(tmp, this.indexPath);
    } catch (err) {
      // 若 rename 失敗（極少見），嘗試重新讀取並合併
      console.warn(
        `[store] appendIndex rename failed, retrying merge: ${(err as Error).message}`,
      );
      try {
        const latestRaw = await readFile(this.indexPath, "utf-8").catch(
          () => "[]",
        );
        const latest = JSON.parse(latestRaw) as MemEntry[];
        if (!latest.some((e) => e.id === entry.id)) {
          latest.push(entry);
          await writeFile(
            this.indexPath,
            JSON.stringify(latest, null, 2),
            "utf-8",
          );
        }
      } catch (retryErr) {
        console.error(
          `[store] appendIndex retry failed: ${(retryErr as Error).message}`,
        );
      } finally {
        // 清理暫存檔
        try {
          await unlink(tmp);
        } catch {}
      }
    }
  }

  get entriesDirPath(): string {
    return this.entriesDir;
  }

  get indexPath(): string {
    return this._indexPath;
  }

  // ── Knowledge store (for peer push) ──

  async storeKnowledge(
    title: string,
    content: string,
    opts?: { category?: string; tags?: string[] },
  ): Promise<{ path: string }> {
    const slug = slugify(title);
    const fileId = `knowledge-${Date.now()}-${slug}`;
    const cat = opts?.category ?? "general";
    const tags = opts?.tags ?? ["knowledge", "peer"];
    const device = getDeviceName();
    const frontmatter = [
      "---",
      `title: ${title}`,
      `category: ${cat}`,
      `tags: [${tags.join(", ")}]`,
      `device: ${device}`,
      `created: ${new Date().toISOString()}`,
      "---",
      "",
      content,
    ].join("\n");

    const knowledgeDir = resolve(this.root, "../knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    const fp = resolve(knowledgeDir, `${fileId}.md`);
    await writeFile(fp, frontmatter, "utf-8");
    return { path: fp };
  }

  // ── Wiki store (for peer push) ──

  async storeWiki(
    id: string,
    content: string,
    opts?: { category?: string; tags?: string[] },
  ): Promise<{ path: string }> {
    const cat = opts?.category ?? "unknown";
    // lesson 存到 skill/lesson/ 而非 wiki/lesson/
    const targetDir =
      cat === "lesson" ? LESSON_DIR : resolve(this.root, `../wiki/${cat}`);
    await mkdir(targetDir, { recursive: true });
    // Use basename only to prevent double path nesting (id may contain category prefix)
    const basename = id.split("/").pop() || id;
    const fp = resolve(targetDir, `${basename}.md`);
    await writeFile(fp, content, "utf-8");

    // Update wiki-index.json
    const wikiIndexDir = resolve(this.root, "..");
    const indexPath = resolve(wikiIndexDir, "wiki-index.json");
    let index: Record<string, unknown> = {};
    try {
      index = JSON.parse(await readFile(indexPath, "utf-8"));
    } catch {
      /* fresh start */
    }
    (index as any)[id] = {
      title: id,
      category: cat,
      tags: opts?.tags ?? ["peer"],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
    return { path: fp };
  }
}

// ── JS-length-aware truncation ──
// JS `.length` = UTF-16 code units. Emoji (Non-BMP) = 2 units, but Python `len()` = 1.
// This ensures summaries fit within API's `validStr(summary, 1000)` check.
function truncToJSLen(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  let n = 0;
  let out = "";
  for (const c of chars) {
    const add = c.length; // 1 for BMP, 2 for supplementary (emoji)
    if (n + add > max - 3) break;
    out += c;
    n += add;
  }
  return out + "...";
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}

// ── Utils ──

// ── 天堂專案關鍵字映射 ──
// 自動辨識內容屬於哪個專案，用於分類與查詢過濾

const PROJECT_KEYWORDS: Record<string, string[]> = {
  貓大: ["貓大", "貓大版", "maoda", "lin880", "變身", "血盟", "攻城"],
  重製王國: [
    "重製",
    "重製王國",
    "remaster",
    "王國",
    "城堡",
    "remaster kingdom",
  ],
  "880": ["880", "天堂880", "lin880", "傳送", "裝備", "lin server"],
};

const TOPIC_TAGS: [RegExp, string][] = [
  [/設定|config|安裝|配置/i, "config"],
  [/測試|test/i, "test"],
  [/除錯|debug|修復|error|bug|fix/i, "debug"],
  [/插件|plugin/i, "plugin"],
  [/記憶|memory/i, "memory"],
  [/api|rest|http|fetch|endpoint/i, "api"],
  [/docker|容器/i, "docker"],
  [/typescript|bun|node/i, "typescript"],
  [/資料庫|db|sql|mariadb|mysql|drizzle/i, "database"],
  [/tailscale|vpn|tailnet|ssh/i, "network"],
  [/git|github|pr|branch|commit|push|pull/i, "git"],
  [/linux|ubuntu|bash|shell|script/i, "linux"],
  [/windows|bat|vbs|cmd/i, "windows"],
  [/telegram|bot|電報/i, "telegram"],
  [/qwen|ai|模型|llm|proxy|chat/i, "ai"],
  [/部署|deploy|啟動|start|service|systemd/i, "deploy"],
];

function inferProject(text: string): string | null {
  for (const [proj, kws] of Object.entries(PROJECT_KEYWORDS)) {
    for (const kw of kws) {
      if (text.includes(kw)) return proj;
    }
  }
  return null;
}

function inferCategory(text: string): string {
  const proj = inferProject(text);
  // 有專案資訊 → 歸類到該專案類別
  if (proj) return `天堂專案-${proj}`;

  if (text.includes("設定") || text.includes("config") || text.includes("安裝"))
    return "fact";
  if (text.includes("決定") || text.includes("決策") || text.includes("規則"))
    return "decision";
  if (text.includes("事件") || text.includes("測試") || text.includes("完成"))
    return "event";
  if (text.includes("偏好") || text.includes("喜歡") || text.includes("習慣"))
    return "preference";
  if (
    text.includes("修復") ||
    text.includes("除錯") ||
    text.includes("error") ||
    text.includes("bug") ||
    text.includes("fail")
  )
    return "fix";
  if (
    text.includes("安裝") ||
    text.includes("設置") ||
    text.includes("tool") ||
    text.includes("cli")
  )
    return "tool";
  return "fact";
}

function inferTags(text: string): string[] {
  const tags: string[] = [];

  // 專案標籤（優先）
  const proj = inferProject(text);
  if (proj) tags.push(proj);

  // 主題標籤
  for (const [re, tag] of TOPIC_TAGS) {
    if (re.test(text) && !tags.includes(tag)) tags.push(tag);
  }

  // 通用天堂標籤
  if (/天堂|私服|lin/i.test(text) && !tags.includes("天堂")) tags.push("天堂");

  return tags.length > 0 ? tags : ["general"];
}

function getDeviceName(): string {
  try {
    return hostname() || "unknown";
  } catch {
    return process.env.HOSTNAME || process.env.COMPUTERNAME || "unknown";
  }
}
