/// <reference types="bun" />
// Telegram Memory Bridge — api.ts
// HTTP API（Tailscale 提供網路隔離，僅 tailnet 內可存取）

import { hostname } from "os";
import type { MemStore } from "./store";
import type { ApiError, RecallResult, StoreResult } from "./types";
import type { Role } from "./types/push";
import { webSearch, webFetch, summarizeWithQwen } from "./websearch";
import { ConversationStore } from "./conversation-store";

export interface ApiConfig {
  port: number;
  store: MemStore;
  role: Role;
}

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
  // localhost / tailnet 內部請求不計 rate limit
  if (ip === "127.0.0.1" || ip === "::1" || ip === "unknown") return true;
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
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reqCount) {
    if (now > v.reset) reqCount.delete(k);
  }
}, 300_000);

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

        // ── Qwen ask ──
        if (method === "POST" && path === "/api/ask") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.question, 2000))
            return json({ error: "question required (max 2000 chars)" }, 400);
          const entries = await store.searchByModel(body.question as string, 5);
          const memoryText = entries.entries
            .map(
              (e, i) => `[${i + 1}] ${e.summary} (${e.category}, ${e.score}%)`,
            )
            .join("\n");
          const system =
            "你是一個記憶助手。根據提供的記憶回答問題。保持簡潔，繁體中文。";
          const prompt = `相關記憶：\n${memoryText || "無相關記憶"}\n\n問題：${body.question}`;
          const answer = await store.qwenAsk(system, prompt);
          return json({
            question: body.question,
            answer,
            matchedCount: entries.entries.length,
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

        // ── Health ──
        if (method === "GET" && path === "/api/health") {
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

        // ── Push memory entry (from peer) ──
        if (method === "POST" && path === "/api/push/memory") {
          const body = (await req.json()) as Record<string, unknown>;
          if (!validStr(body.summary, 1000))
            return json({ error: "summary required" }, 400);
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
