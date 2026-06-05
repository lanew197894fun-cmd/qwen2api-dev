// Telegram Memory Bridge — store.ts
// 本地記憶/知識/維基的檔案操作層

import type {
  MemEntry,
  MemFile,
  StoreResult,
  RecallResult,
  SyncState,
} from "./types";
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
import {
  recordApiCall,
  startCall,
  endCall,
  setQueueDepth,
  suggest,
} from "./governor";

const CHAT_URL =
  process.env.CHAT_URL || "http://127.0.0.1:3456/v1/chat/completions";
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
const semQueue: (() => void)[] = [];
let semLastLog = 0;

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

  if (timeoutMs) {
    const acquired = await Promise.race([
      new Promise<boolean>((resolve) => {
        semQueue.push(() => resolve(true));
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs),
      ),
    ]);
    if (!acquired) {
      // 超時時不增加 semActive，避免計數器洩漏
      throw new Error(`Semaphore acquire timeout after ${timeoutMs}ms`);
    }
    // 成功取得 slot 後才遞增
    semActive++;
  } else {
    await new Promise<void>((r) => semQueue.push(r));
    semActive++;
  }
}

function semRelease(): void {
  const next = semQueue.shift();
  if (next) next();
  else semActive--;
  setQueueDepth(semQueue.length);
}

/** 硬性超時保護，確保不會無限等待 */
const HARD_TIMEOUT_MS = Number(process.env.QWEN_HARD_TIMEOUT_MS) || 30000;

function requestTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms),
  );
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
    const map: Record<string, string> = {
      small: "qwen3.6-27b",
      medium: "qwen3.7-plus",
      large: this.qwenModel, // 使用者設定的主模型
    };
    return map[tier] || this.qwenModel;
  }

  async qwenAsk(system: string, userMsg: string): Promise<string> {
    // 先查 governor 狀態決定策略
    const gov = suggest();

    // 極高負載 + 極簡訊息 → 跳過 AI，直接回確認
    if (gov.skipAIfIfTrivial && this.isTrivial(userMsg)) {
      const replies = ["✅ 收到", "👌 好的", "📝 已記錄", "✔️ 了解"];
      console.log(`[qwen:skip] ${gov.info}`);
      return replies[Math.floor(Math.random() * replies.length)];
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
          return data.choices[0].message.content;
        }
        console.warn(`[qwen:fast] ${res.status} → 降級`);
      } catch (e) {
        console.warn(`[qwen:fast] ${(e as Error).message} → 降級`);
      }
    }

    // 正常通道（受 governor 動態控制）
    // semAcquire 有內建 timeout，API call 有 Promise.race，
    // 不需要額外硬超時——避免跟 semAcquire timeout 競爭造成計數偏移
    await semAcquire(HARD_TIMEOUT_MS);
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

    try {
      // ⚡ 使用 Promise.race 確保不會超過硬性超時
      const result = await Promise.race([
        this.fetchWithRetry(model, system, userMsg, timeoutMs, maxRetries, gov),
        requestTimeout(timeoutMs + 5000), // 給予 fetchWithRetry 額外緩衝時間
      ]);
      const elapsed = performance.now() - t0;
      console.log(`[qwen] ${model} ${Math.round(elapsed)}ms (${gov.info})`);
      return result as string;
    } catch (e) {
      ok = false;
      console.error(`[qwen] Failed: ${(e as Error).message}`);
      throw e;
    } finally {
      semRelease();
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
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
            max_tokens: gov.modelTier === "small" ? 256 : 1024,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          if (res.status >= 500 && attempt < maxRetries) {
            const wait = Math.min(1000 * 2 ** attempt, 5000);
            console.warn(
              `[qwen] ${res.status} 重試 ${attempt + 1}/${maxRetries}，等待 ${wait}ms`,
            );
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          console.error(`[qwen] ${res.status}: ${txt.slice(0, 200)}`);
          throw new Error(`qwen error ${res.status}`);
        }
        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        return data.choices[0].message.content;
      } catch (e) {
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

  async searchByModel(query: string, limit = 10): Promise<RecallResult> {
    const all = await this.list();
    if (all.length === 0) return { entries: [], total: 0 };

    const memoryList = all
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
        .filter((p) => p.index >= 0 && p.index < all.length && p.score > 0)
        .map((p) => {
          const e = all[p.index];
          return {
            ...e,
            score: Math.round(p.score) / 100,
            reason: p.reason || "",
            device: e.device || "unknown",
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return { entries: scored, total: all.length };
    } catch {
      return { entries: [], total: all.length };
    }
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
    const id = `mem-${Date.now()}-${slugify(summary)}`;
    const cat = opts?.category ?? inferCategory(summary);
    const imp = opts?.importance ?? 0.7;
    const tags = opts?.tags ?? inferTags(summary);
    const content = opts?.content ?? summary;
    const device = getDeviceName();

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
    const q = query.toLowerCase();
    const entries = await this.list();

    const scored = entries
      .map((e) => {
        let score = 0;
        const s = e.summary.toLowerCase();
        const t = e.tags.map((t) => t.toLowerCase());
        // keyword match
        const words = q.split(/\s+/);
        for (const w of words) {
          if (s.includes(w)) score += 0.3;
          if (t.some((t) => t.includes(w))) score += 0.5;
          if (e.category === w || e.category.includes(w)) score += 0.4;
        }
        return { ...e, score, device: (e as any).device || "unknown" };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { entries: scored, total: entries.length };
  }

  async searchByTag(tag: string): Promise<MemEntry[]> {
    const entries = await this.list();
    return entries.filter((e) =>
      e.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
    );
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
    const wikiDir = resolve(this.root, `../wiki/${cat}`);
    await mkdir(wikiDir, { recursive: true });
    // Use basename only to prevent double path nesting (id may contain category prefix)
    const basename = id.split("/").pop() || id;
    const fp = resolve(wikiDir, `${basename}.md`);
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
