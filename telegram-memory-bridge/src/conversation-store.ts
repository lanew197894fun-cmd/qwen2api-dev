// Telegram Memory Bridge — conversation-store.ts
// 完整對話歷史儲存（JSONL 格式 + index 索引）
// 儲存位置: ~/.opencode/conversations/
//    raw/YYYY-MM/<sessionId>.jsonl  — 原始訊息
//    sessions/<sessionId>.json      — session 摘要
//    index.json                     — 快速查詢

import { mkdir, readFile, writeFile, appendFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { hostname } from "os";

const CONV_DIR = resolve(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".opencode/conversations",
);

export interface ConvMsg {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  ts: string;
  source: "telegram" | "proxy" | "api";
  model?: string;
}

export interface ConvSessionSummary {
  purpose?: string;
  keyPoints?: string[];
  decisions?: string[];
  files?: string[];
  commands?: string[];
  tags?: string[];
}

export interface ConvSession {
  id: string;
  date: string;
  source: string;
  chatId?: number;
  msgCount: number;
  firstTs: string;
  lastTs: string;
  tags: string[];
  summary?: string;
  detail?: ConvSessionSummary;
}

interface ConvIdx {
  [k: string]: ConvSession;
}

const DAY = 86_400_000;

export function makeSessionId(
  source: string,
  chatId?: number | string,
): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const suffix = chatId != null ? String(chatId) : hostname();
  return `${day}-${source}-${suffix}`;
}

// LRU Cache for session messages
const MAX_CACHE_SIZE = 50;
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}

export class ConversationStore {
  private dir: string;
  private indexFile: string;
  private sessionDir: string;
  private rawDir: string;
  private idxCache: ConvIdx | null = null;
  private askFn: ((sys: string, usr: string) => Promise<string>) | null = null;
  private msgCache = new LRUCache<string, ConvMsg[]>(MAX_CACHE_SIZE);

  constructor(
    baseDir?: string,
    askFn?: (sys: string, usr: string) => Promise<string>,
  ) {
    this.dir = baseDir || CONV_DIR;
    this.askFn = askFn || null;
    this.indexFile = resolve(this.dir, "index.json");
    this.sessionDir = resolve(this.dir, "sessions");
    this.rawDir = resolve(this.dir, "raw");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await mkdir(this.rawDir, { recursive: true });
  }

  /** 讀取索引（公開供外部查詢） */
  async loadIdx(): Promise<ConvIdx> {
    if (this.idxCache) return this.idxCache;
    try {
      this.idxCache = JSON.parse(await readFile(this.indexFile, "utf-8"));
    } catch {
      this.idxCache = {};
    }
    return this.idxCache!;
  }

  private async saveIdx(): Promise<void> {
    if (!this.idxCache) return;
    await writeFile(this.indexFile, JSON.stringify(this.idxCache, null, 2));
  }

  /** 記錄單條訊息 */
  async record(sessionId: string, msg: ConvMsg): Promise<void> {
    const d = new Date(msg.ts);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthDir = resolve(this.rawDir, month);
    await mkdir(monthDir, { recursive: true });

    const rawFile = resolve(monthDir, `${sessionId}.jsonl`);
    await appendFile(rawFile, JSON.stringify(msg) + "\n", "utf-8");

    const idx = await this.loadIdx();
    const day = msg.ts.slice(0, 10);
    if (idx[sessionId]) {
      idx[sessionId].msgCount++;
      idx[sessionId].lastTs = msg.ts;
    } else {
      idx[sessionId] = {
        id: sessionId,
        date: day,
        source: msg.source,
        msgCount: 1,
        firstTs: msg.ts,
        lastTs: msg.ts,
        tags: [],
      };
    }
    await this.saveIdx();
  }

  /** 記錄一輪對話（user + assistant） */
  async recordTurn(
    sessionId: string,
    userMsg: string,
    assistantMsg: string,
    source: "telegram" | "proxy" | "api",
    model?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.record(sessionId, {
      role: "user",
      content: userMsg,
      ts: now,
      source,
    });
    await this.record(sessionId, {
      role: "assistant",
      content: assistantMsg,
      ts: new Date().toISOString(),
      source,
      model,
    });
  }

  /** 記錄單條角色訊息（支援過濾閒聊與自動標記） */
  async recordMsg(
    sessionId: string,
    role: ConvMsg["role"],
    content: string,
    source: ConvMsg["source"],
    model?: string,
    filterTrivial = false,
  ): Promise<void> {
    // 過濾極簡閒聊（若啟用）
    if (filterTrivial && role === "user") {
      const t = content.trim();
      if (t.length > 60) return; // 長訊息不過濾
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
        "hi",
        "hello",
      ];
      if (trivia.includes(t.toLowerCase())) return;
      if (/^[👍👌✅🙏😊❤️]+$/.test(t)) return;
    }

    await this.record(sessionId, {
      role,
      content,
      ts: new Date().toISOString(),
      source,
      model,
    });
  }

  /** 取得 session 列表（依時間倒序） */
  async listSessions(opts?: {
    source?: string;
    limit?: number;
    offset?: number;
  }): Promise<ConvSession[]> {
    const idx = await this.loadIdx();
    let sessions = Object.values(idx);
    if (opts?.source)
      sessions = sessions.filter((s) => s.source === opts.source);
    sessions.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
    const off = opts?.offset ?? 0;
    const lim = opts?.limit ?? 50;
    return sessions.slice(off, off + lim);
  }

  /** 取得單個 session 的全部訊息（使用 LRU 快取） */
  async getSession(sessionId: string): Promise<ConvMsg[]> {
    // Check cache first
    const cached = this.msgCache.get(sessionId);
    if (cached) return cached;

    const idx = await this.loadIdx();
    const meta = idx[sessionId];
    if (!meta) return [];
    const [year, month] = meta.date.split("-");
    const rawFile = resolve(
      this.rawDir,
      `${year}-${month}`,
      `${sessionId}.jsonl`,
    );
    let msgs: ConvMsg[] = [];
    try {
      const content = await readFile(rawFile, "utf-8");
      msgs = content
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // 可能跨月份，搜尋所有月份
      const entries = await readdir(this.rawDir).catch(() => []);
      for (const m of entries.sort().reverse()) {
        const fp = resolve(this.rawDir, m, `${sessionId}.jsonl`);
        if (existsSync(fp)) {
          const content = await readFile(fp, "utf-8");
          msgs = content
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l));
          break;
        }
      }
    }
    // Store in cache
    if (msgs.length > 0) {
      this.msgCache.set(sessionId, msgs);
    }
    return msgs;
  }

  /** 全文搜尋對話（優化：限制掃描範圍與使用快取） */
  async search(
    keyword: string,
    opts?: { source?: string; limit?: number },
  ): Promise<{ sessionId: string; matches: ConvMsg[] }[]> {
    const sessions = await this.listSessions({
      source: opts?.source,
      limit: 20, // 減少初始掃描範圍
    });
    const results: { sessionId: string; matches: ConvMsg[] }[] = [];
    const kw = keyword.toLowerCase();

    for (const s of sessions) {
      // 使用 getSession 以利用 LRU 快取
      const msgs = await this.getSession(s.id);
      const matches = msgs.filter(
        (m) =>
          typeof m.content === "string" && m.content.toLowerCase().includes(kw),
      );
      if (matches.length > 0) {
        results.push({ sessionId: s.id, matches: matches.slice(0, 5) }); // 每 session 最多 5 筆匹配
        if (results.length >= (opts?.limit || 5)) break;
      }
    }
    return results;
  }

  /** 讀取已儲存的 session 摘要（若無則回傳 null） */
  async getSessionSummary(sessionId: string): Promise<string | null> {
    const idx = await this.loadIdx();
    if (idx[sessionId]?.summary) return idx[sessionId].summary!;
    // 嘗試從 session 檔案讀取
    const sf = resolve(this.sessionDir, `${sessionId}.json`);
    try {
      const data = JSON.parse(await readFile(sf, "utf-8")) as ConvSession;
      return data.summary || null;
    } catch {
      return null;
    }
  }

  /** 產生 AI 摘要並儲存（需在建構時提供 askFn） */
  async summarizeSession(
    sessionId: string,
  ): Promise<ConvSessionSummary | null> {
    if (!this.askFn) {
      console.warn("[conv] summarizeSession: askFn 未設定");
      return null;
    }
    const msgs = await this.getSession(sessionId);
    if (msgs.length < 2) return null;
    const text = msgs
      .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
      .join("\n");
    const sys =
      "你是一個對話摘要助手。請分析以下對話，並回傳 JSON 格式：{ purpose: string, keyPoints: string[], decisions: string[], files: string[], commands: string[], tags: string[] }。若無相關內容則留空陣列或 null。";
    try {
      const raw = await this.askFn(sys, text);
      // 嘗試解析 JSON
      let detail: ConvSessionSummary;
      try {
        detail = JSON.parse(raw);
      } catch {
        // 若非 JSON，fallback 為純文字摘要
        detail = {
          purpose: raw.slice(0, 200),
          keyPoints: [],
          decisions: [],
          files: [],
          commands: [],
          tags: [],
        };
      }

      // 更新 index
      const idx = await this.loadIdx();
      if (idx[sessionId]) {
        idx[sessionId].summary = detail.purpose || raw.slice(0, 100);
        idx[sessionId].detail = detail;
        await this.saveIdx();
      }
      // 儲存到 session 檔案
      const sf = resolve(this.sessionDir, `${sessionId}.json`);
      const existing: ConvSession = idx[sessionId] || {
        id: sessionId,
        date: new Date().toISOString().slice(0, 10),
        source: "unknown",
        msgCount: msgs.length,
        firstTs: msgs[0]?.ts || "",
        lastTs: msgs[msgs.length - 1]?.ts || "",
        tags: [],
        summary: detail.purpose || raw.slice(0, 100),
        detail,
      };
      existing.summary = detail.purpose || raw.slice(0, 100);
      existing.detail = detail;
      await writeFile(sf, JSON.stringify(existing, null, 2), "utf-8");
      return detail;
    } catch (e) {
      console.error(`[conv] summarizeSession 失敗:`, (e as Error).message);
      return null;
    }
  }

  /** 統計 */
  async stats(): Promise<{
    totalSessions: number;
    totalMsgs: number;
    bySource: Record<string, number>;
  }> {
    const idx = await this.loadIdx();
    const sessions = Object.values(idx);
    const bySource: Record<string, number> = {};
    let totalMsgs = 0;
    for (const s of sessions) {
      bySource[s.source] = (bySource[s.source] || 0) + 1;
      totalMsgs += s.msgCount;
    }
    return { totalSessions: sessions.length, totalMsgs, bySource };
  }
}
