/// <reference types="bun" />
// Telegram Memory Bridge — api.ts
// HTTP API（Tailscale 提供網路隔離，僅 tailnet 內可存取）

import { hostname, networkInterfaces } from "os";
import { execSync } from "child_process";
import {
  readdirSync,
  statSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "fs";
import { resolve } from "path";
import type { MemStore } from "./store.ts";
import type { ApiError, RecallResult, StoreResult } from "./types.ts";
import type { Role } from "./types/push.ts";
import { webSearch, webFetch, summarizeWithQwen } from "./websearch.ts";
import { ConversationStore } from "./conversation-store.ts";

export interface ApiConfig {
  port: number;
  store: MemStore;
  role: Role;
  knowledgePath?: string;
  wikiPath?: string;
  lessonPath?: string;
  opencodeRoot?: string;
  onPullRequest?: (peerUrl: string) => Promise<void>;
  /** 啟動完成前回 503，讓 start.mjs 等到真正就緒才印健康報告 */
  readyRef?: { current: boolean };
}

// ── 本地 IP 集合（用於跳過 rate limit） ──

const LOCAL_IPS = new Set<string>(["127.0.0.1", "::1", "unknown"]);

// ═══ 追蹤已知 peer 連線（首次推送時顯示🎉）═══
const _knownPeers = new Set<string>();

function initLocalIPs(): void {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        LOCAL_IPS.add(net.address);
      }
    }
  } catch {}
  try {
    const out = execSync("tailscale ip -4", { timeout: 3000 })
      .toString()
      .trim();
    if (out) LOCAL_IPS.add(out);
  } catch {}
}
initLocalIPs();

// ── 簡易速率限制（memory-based，依真實來源 IP） ──

const reqCount = new Map<string, { count: number; reset: number }>();
const RATE_MAX = 600; // 每分鐘最大請求數
const RATE_WIN = 60_000; // 時間視窗（ms）

function getClientIP(
  req: Request,
  srv: { requestIP: (r: Request) => { address: string } | null },
): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const ip = srv.requestIP(req);
  return ip ? ip.address : "unknown";
}

function checkRate(ip: string, path: string): boolean {
  // 本機 IP / tailnet 內部請求不計 rate limit
  if (LOCAL_IPS.has(ip) || ip.startsWith("100.")) return true;
  // 摘要端點不計 rate limit（本身是長時間請求）
  if (path.includes("/conversations/")) return true;
  const now = Date.now();
  const cur = reqCount.get(ip);
  if (!cur || now > cur.reset) {
    reqCount.set(ip, { count: 1, reset: now + RATE_WIN });
    return true;
  }
  cur.count++;
  return cur.count <= RATE_MAX;
}

// 定時清理過期記錄（每 5 分鐘）
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reqCount) {
    if (now > v.reset) reqCount.delete(k);
  }
}, 300_000);

if (typeof process !== "undefined" && process.on) {
  process.on("SIGINT", () => clearInterval(cleanupTimer));
  process.on("SIGTERM", () => clearInterval(cleanupTimer));
}

// ── 輸入驗證 helper ──

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function validTags(tags: unknown): tags is string[] {
  return (
    Array.isArray(tags) &&
    tags.length <= 10 &&
    tags.every((t) => typeof t === "string" && t.length <= 30)
  );
}

function validStr(v: unknown, maxLen: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

// ── API server ──

export function startApi(cfg: ApiConfig) {
  const { port, store } = cfg;

  Bun.serve({
    port,
    hostname: "0.0.0.0", // tailnet 內 peer 可存取
    idleTimeout: 120, // 摘要請求可能 >30s，設 120s 防止被切斷
    async fetch(req: Request, srv: any): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      // 速率限制（依真實來源 IP，摘要端點不計）
      const ip = getClientIP(req, srv);
      if (!checkRate(ip, path)) {
        console.warn(
          `[api] rate limit exceeded from ${ip} — ${method} ${path}`,
        );
        return new Response(JSON.stringify({ error: "too many requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        });
      }

      try {
        // ── Store memory ──
        if (method === "POST" && path === "/api/store") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.summary, 1000))
            return json({ error: "summary required (max 1000 chars)" }, 400);
          if (body.category && !validStr(body.category, 50))
            return json({ error: "invalid category" }, 400);
          if (
            body.importance !== undefined &&
            (typeof body.importance !== "number" ||
              body.importance < 0 ||
              body.importance > 1)
          )
            return json({ error: "importance must be 0-1" }, 400);
          if (body.tags !== undefined && !validTags(body.tags))
            return json({ error: "invalid tags (max 10, each 30 chars)" }, 400);
          if (body.content !== undefined && !validStr(body.content, 20000))
            return json({ error: "content too long (max 20000)" }, 400);

          const result = await store.store(body.summary as string, {
            category: body.category as string | undefined,
            importance: body.importance as number | undefined,
            tags: body.tags as string[] | undefined,
            content: body.content as string | undefined,
          });
          return json(result);
        }

        // ── Semantic search (Qwen-powered) ──
        if (method === "POST" && path === "/api/search") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.query, 1000))
            return json({ error: "query required (max 1000 chars)" }, 400);
          const limit = Math.min(Math.max(+(body.limit ?? 10), 1), 50);
          const result = await store.searchByModel(body.query as string, limit);
          return json(result);
        }

        // ── Qwen ask（強化：自動搜尋記憶+知識庫+維基+經驗教訓） ──
        if (method === "POST" && path === "/api/ask") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.question, 2000))
            return json({ error: "question required (max 2000 chars)" }, 400);
          const q = body.question as string;

          // 1. 記憶搜尋（純本地關鍵字檢索 — 背景上下文不需模型評分）
          const entries = await store.recall(q, 5);
          const mem = entries.entries
            .map(
              (e, i) =>
                `[${i + 1}] ${e.summary} (${e.category}, ${(e.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          // 2. 知識庫 + 維基 + 教訓 全文搜尋
          const know = await searchDir(cfg.knowledgePath || "", q, 3);
          const wiki = await searchDir(cfg.wikiPath || "", q, 3);
          const less = await searchDir(cfg.lessonPath || "", q, 3);

          // 3. 組裝完整上下文
          const ctx: string[] = [];
          if (mem) ctx.push(`📝 相關記憶：\n${mem}`);
          if (know) ctx.push(`\n📚 相關知識：\n${know}`);
          if (wiki) ctx.push(`\n📖 相關維基：\n${wiki}`);
          if (less) ctx.push(`\n⚠️ 相關教訓：\n${less}`);
          const allCtx = ctx.join("\n") || "（無相關資料）";

          const system =
            "你是一個全知的開發助手。以下是與問題相關的記憶、知識庫、維基和經驗教訓。\n" +
            "請根據這些資訊回答，並在適當時引用來源。保持繁體中文。\n\n" +
            "小提醒：\n" +
            "• 遇到問題解決後，可用 lesson/save 記錄經驗教訓\n" +
            "• 學到新技術或架構，可用 knowledge/save 存入知識庫\n" +
            "• 重要的長期文件，可用 wiki/save 建立維基條目";
          const prompt = `## 相關上下文\n\n${allCtx}\n\n## 問題\n${q}`;
          const answer = await store.qwenAsk(system, prompt);
          return json({
            question: q,
            answer,
            matchedMemory: entries.entries.length,
            matchedKnowledge: know ? know.split("\n").length : 0,
            matchedWiki: wiki ? wiki.split("\n").length : 0,
            matchedLessons: less ? less.split("\n").length : 0,
          });
        }

        // ── Recall / Search ──
        if (method === "GET" && path === "/api/recall") {
          const query =
            url.searchParams.get("q") || url.searchParams.get("query") || "";
          if (query.length > 500) return json({ error: "query too long" }, 400);
          const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") || "10"), 1),
            50,
          );
          if (!query) return json({ error: "query required (q=)" }, 400);
          const result = await store.recall(query, limit);
          return json(result);
        }

        // ── List ──
        if (method === "GET" && path === "/api/list") {
          const entries = await store.list();
          return json({ entries, total: entries.length });
        }

        // ── Stats ──
        if (method === "GET" && path === "/api/stats") {
          const s = await store.stats();
          return json(s);
        }

        // ── Read entry ──
        if (method === "GET" && path.startsWith("/api/entry/")) {
          const id = path.slice("/api/entry/".length);
          if (!validId(id)) return json({ error: "invalid entry id" }, 400);
          const content = await store.readContent(id);
          if (!content) return json({ error: "not found" }, 404);
          return json({ id, content });
        }

        // ── Knowledge listing ──
        if (method === "GET" && path === "/api/knowledge") {
          const files = listMarkdownFiles(cfg.knowledgePath || "");
          return json({ files, device: hostname() });
        }

        // ── Wiki listing ──
        if (method === "GET" && path === "/api/wiki") {
          const files = listMarkdownFiles(cfg.wikiPath || "");
          return json({ files, device: hostname() });
        }

        // ── Lesson listing ──
        if (method === "GET" && path === "/api/lesson") {
          const files = listMarkdownFiles(cfg.lessonPath || "");
          return json({ files, device: hostname() });
        }

        // ── Read knowledge/wiki/lesson file by relative path ──
        if (method === "GET" && path === "/api/read") {
          const type = url.searchParams.get("type") || "";
          const relPath = url.searchParams.get("path") || "";
          const baseDir =
            type === "wiki"
              ? cfg.wikiPath
              : type === "lesson"
                ? cfg.lessonPath
                : cfg.knowledgePath;
          if (!baseDir || !relPath)
            return json({ error: "type and path required" }, 400);
          const full = resolve(baseDir, relPath);
          if (!full.startsWith(resolve(baseDir)))
            return json({ error: "path traversal" }, 403);
          if (!existsSync(full)) return json({ error: "not found" }, 404);
          const content = readFileSync(full, "utf-8");
          return json({ content });
        }

        // ── Cleanup synced files on source (pull 完成後刪除原始檔) ──
        if (method === "POST" && path === "/api/cleanup") {
          const body = (await req.json()) as Record<string, unknown>;
          const files = body.files as
            | { type: string; path: string }[]
            | undefined;
          if (!Array.isArray(files))
            return json({ error: "files array required" }, 400);
          let deleted = 0;
          const errors: string[] = [];
          for (const f of files) {
            const baseDir =
              f.type === "wiki"
                ? cfg.wikiPath
                : f.type === "knowledge"
                  ? cfg.knowledgePath
                  : f.type === "lesson"
                    ? cfg.lessonPath
                    : "";
            if (!baseDir) {
              errors.push(`${f.type}:${f.path} → 未知類型`);
              continue;
            }
            const full = resolve(baseDir, f.path);
            if (!full.startsWith(resolve(baseDir))) {
              errors.push(`${f.path} → 路徑越界`);
              continue;
            }
            try {
              unlinkSync(full);
              deleted++;
              console.log(`[cleanup] 🗑️ 刪除 ${f.type}: ${f.path}`);
              // 清理空目錄（遞迴向上）
              let dir = resolve(full, "..");
              while (dir.startsWith(resolve(baseDir))) {
                const entries = readdirSync(dir);
                if (entries.length > 0) break;
                try {
                  const { rmdirSync } = await import("fs");
                  rmdirSync(dir);
                } catch {
                  /* */
                }
                dir = resolve(dir, "..");
              }
            } catch (err) {
              errors.push(`${f.path} → ${(err as Error).message}`);
            }
          }
          return json({
            deleted,
            errors: errors.length > 0 ? errors : undefined,
          });
        }

        // ── Trigger pull from peer (master only) ──
        if (method === "POST" && path === "/api/pull/now") {
          if (!cfg.onPullRequest)
            return json({ error: "pull not available (not master)" }, 503);
          const body = (await req.json()) as Record<string, string>;
          const peerUrl = body.url || "";
          if (!peerUrl) return json({ error: "url required" }, 400);
          // Fire-and-forget: don't block the response
          cfg
            .onPullRequest(peerUrl)
            .catch((err) =>
              console.error(`[api] pull error: ${(err as Error).message}`),
            );
          return json({ ok: true, message: "pull triggered", peer: peerUrl });
        }

        // ── Health ──
        if (method === "GET" && path === "/api/health") {
          // 啟動未完成前回 503，讓 launcher 等到真正就緒
          if (cfg.readyRef && !cfg.readyRef.current)
            return json({ status: "starting", mode: cfg.role }, 503);
          const stats = await store.stats();
          return json({
            status: "ok",
            mode: cfg.role,
            hostname: hostname(),
            memoryCount: stats.total,
            timestamp: new Date().toISOString(),
          });
        }

        // ── Web Search ──
        if (method === "POST" && path === "/api/websearch") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.query, 500))
            return json({ error: "query required (max 500 chars)" }, 400);
          const limit = Math.min(Math.max(+(body.limit ?? 5), 1), 15);
          const results = await webSearch(body.query as string, limit);

          // Optionally summarize with AI
          let summary = "";
          if (body.summarize !== false) {
            try {
              summary = await summarizeWithQwen(
                (sys: string, usr: string) => store.qwenAsk(sys, usr),
                body.query as string,
                results,
              );
            } catch {
              /* optional */
            }
          }

          return json({
            query: body.query,
            results,
            summary,
            count: results.length,
          });
        }

        // ── Web Fetch ──
        if (method === "POST" && path === "/api/webfetch") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.url, 2000))
            return json({ error: "url required (max 2000 chars)" }, 400);
          const maxLen = Math.min(
            Math.max(+(body.maxLength ?? 3000), 500),
            10000,
          );
          const text = await webFetch(body.url as string, maxLen);

          let summary = text;
          if (body.summarize !== false && text.length > 500) {
            try {
              const sys =
                "摘要以下網頁內容，保留關鍵資訊，使用繁體中文，保持在 500 字內。";
              summary = await store.qwenAsk(sys, text);
            } catch {
              /* optional */
            }
          }

          return json({
            url: body.url,
            content: summary,
            rawLength: text.length,
          });
        }

        // ── Search by tag ──
        if (method === "GET" && path === "/api/tag") {
          const tag = url.searchParams.get("tag") || "";
          if (tag.length > 50) return json({ error: "tag too long" }, 400);
          if (!tag) return json({ error: "tag required" }, 400);
          const entries = await store.searchByTag(tag);
          return json({ entries, total: entries.length });
        }

        // ── Push memory entry (from peer) with idempotency check ──
        if (method === "POST" && path === "/api/push/memory") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.summary, 1000))
            return json({ error: "summary required" }, 400);

          // ═══ 首次收到 peer 推送 → 顯示🎉連線確認 ═══
          const _peerId = (body as any)._peer || "";
          if (_peerId && !_knownPeers.has(_peerId)) {
            _knownPeers.add(_peerId);
            console.log(
              `🎉🎉🎉 主力機收到來自「${_peerId}」的首次推送！跨裝置連接成功！🎉🎉🎉`,
            );
          }

          // P0 修復：冪等性檢查 - 若提供 id 則檢查是否已存在
          const providedId = body.id as string | undefined;
          if (providedId) {
            try {
              const existing = await store.recallById(providedId);
              if (existing) {
                console.log(`[api] 記憶 ${providedId} 已存在，跳過重複推送`);
                return json({
                  id: providedId,
                  skipped: true,
                  peer: (body as any)._peer || "unknown",
                });
              }
            } catch (e) {
              // recallById 失敗（如檔案不存在）視為可寫入
              console.debug(
                `[api] 檢查 ${providedId} 時發生錯誤: ${(e as Error).message}`,
              );
            }
          }

          const result = await store.store(body.summary as string, {
            category: body.category as string | undefined,
            importance: body.importance as number | undefined,
            tags: body.tags as string[] | undefined,
            content: body.content as string | undefined,
          });
          return json({ ...result, peer: (body as any)._peer || "unknown" });
        }

        // ── Push knowledge entry (from peer) ──
        if (method === "POST" && path === "/api/push/knowledge") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.title, 500) || !validStr(body.content, 50000))
            return json({ error: "title and content required" }, 400);
          const saved = await store.storeKnowledge(
            body.title as string,
            body.content as string,
            {
              category: body.category as string | undefined,
              tags: body.tags as string[] | undefined,
            },
          );
          return json({ ...saved, peer: (body as any)._peer || "unknown" });
        }

        // ── Push wiki entry (from peer) ──
        if (method === "POST" && path === "/api/push/wiki") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.id, 200) || !validStr(body.content, 100000))
            return json({ error: "id and content required" }, 400);
          const saved = await store.storeWiki(
            body.id as string,
            body.content as string,
            {
              category: body.category as string | undefined,
              tags: body.tags as string[] | undefined,
            },
          );
          return json({ ...saved, peer: (body as any)._peer || "unknown" });
        }

        // ── Conversation history ──
        if (method === "GET" && path === "/api/conversations") {
          const conv = new ConversationStore();
          await conv.init();
          const source = url.searchParams.get("source") || undefined;
          const limit = Math.min(
            parseInt(url.searchParams.get("limit") || "20"),
            100,
          );
          const sessions = await conv.listSessions({ source, limit });
          const stats = await conv.stats();
          return json({ sessions, stats });
        }

        if (method === "GET" && path.startsWith("/api/conversations/search")) {
          const q = url.searchParams.get("q") || "";
          if (!q || q.length > 200)
            return json({ error: "query required" }, 400);
          const conv = new ConversationStore();
          await conv.init();
          const results = await conv.search(q, {
            source: url.searchParams.get("source") || undefined,
            limit: Math.min(parseInt(url.searchParams.get("limit") || "5"), 20),
          });
          return json({ query: q, results, count: results.length });
        }

        if (
          method === "GET" &&
          path.startsWith("/api/conversations/") &&
          path.endsWith("/summary")
        ) {
          const baseId = path.slice(
            "/api/conversations/".length,
            -"/summary".length,
          );
          if (!baseId || !/^[\w-]+$/.test(baseId))
            return json({ error: "invalid id" }, 400);
          const conv = new ConversationStore();
          await conv.init();
          const sum = await conv.getSessionSummary(baseId);
          if (!sum) return json({ error: "summary not found" }, 404);
          return json({ sessionId: baseId, summary: sum });
        }

        if (method === "GET" && path.startsWith("/api/conversations/")) {
          // 檢查是否有 ?summarize=1（觸發 AI 摘要生成）
          const summarizeParam = url.searchParams.get("summarize");
          const doSummarize = summarizeParam === "1";
          console.log(
            `[api] conversations GET path=${path} summarize=${summarizeParam} doSummarize=${doSummarize} url=${req.url}`,
          );
          const id = path.slice("/api/conversations/".length);
          if (!id || id === "search") return json({ error: "not found" }, 404);
          // id 僅允許安全字元
          if (!/^[\w-]+$/.test(id)) return json({ error: "invalid id" }, 400);
          const conv = new ConversationStore();
          await conv.init();

          // 若要求觸發摘要
          if (doSummarize) {
            const conv2 = new ConversationStore(undefined, (sys, usr) =>
              store.qwenAsk(sys, usr),
            );
            await conv2.init();
            const detail = await conv2.summarizeSession(id);
            if (!detail)
              return json(
                { error: "summarization failed or too few msgs" },
                400,
              );
            return json({ sessionId: id, summary: detail });
          }

          const msgs = await conv.getSession(id);
          if (msgs.length === 0) return json({ error: "not found" }, 404);
          // 同時回傳摘要（若有）
          const summary = await conv.getSessionSummary(id);
          return json({ sessionId: id, msgs, count: msgs.length, summary });
        }

        return json({ error: "not found" }, 404);
      } catch (err) {
        const msg = (err as Error).message;
        console.error("[api] error:", msg);
        // 不外洩內部細節
        return json({ error: "internal error" }, 500);
      }
    },
  });

  console.log(`[telegram-memory] API: http://0.0.0.0:${port} (tailnet)`);
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listMarkdownFiles(baseDir: string): string[] {
  if (!baseDir || !existsSync(baseDir)) return [];
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir)) {
      const full = resolve(dir, e);
      const s = statSync(full);
      if (s.isDirectory()) walk(full, prefix ? `${prefix}/${e}` : e);
      else if (e.endsWith(".md")) files.push(prefix ? `${prefix}/${e}` : e);
    }
  };
  walk(baseDir, "");
  return files;
}

/**
 * 在指定目錄中搜尋關鍵字，回傳最近修改且相關的 .md 文件摘要。
 * 用於 knowledge/wiki/lesson 等 markdown 知識來源的全文比對。
 */
export function searchDir(dir: string, query: string, max: number): string {
  if (!dir || !existsSync(dir)) return "";
  const q = query.toLowerCase();
  const hits: { file: string; mtime: Date; snippet: string }[] = [];
  const walk = (base: string, prefix: string) => {
    for (const e of readdirSync(base)) {
      const full = resolve(base, e);
      const s = statSync(full);
      if (s.isDirectory()) walk(full, prefix ? `${prefix}/${e}` : e);
      else if (e.endsWith(".md")) {
        try {
          const content = readFileSync(full, "utf-8");
          // 全文關鍵詞比對（簡單但足夠）
          if (content.toLowerCase().includes(q)) {
            const title =
              content.match(/^# (.+)$/m)?.[1] || e.replace(/\.md$/, "");
            // 取關鍵字前後文字作為摘要
            const idx = content.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 60);
            const end = Math.min(content.length, idx + q.length + 120);
            const snippet =
              (start > 0 ? "…" : "") +
              content.slice(start, end).replace(/\n/g, " ").trim() +
              (end < content.length ? "…" : "");
            hits.push({ file: title, mtime: s.mtime, snippet });
          }
        } catch {
          /* 跳過無法讀取的檔案 */
        }
      }
    }
  };
  walk(dir, "");

  // 依修改時間排序（最新的在前面），取前 max 筆
  hits.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return hits
    .slice(0, max)
    .map((h) => `📄 ${h.file}\n   ${h.snippet}`)
    .join("\n");
}
