// Telegram Memory Bridge — bot.ts
// Telegram Bot 處理 — 使用原生 fetch，零依賴

import type { MemStore } from "./store";
import { IdleProcessor, type ProcessorPaths } from "./processor";
import { suggest } from "./governor";
import { webSearch, webFetch, summarizeWithQwen } from "./websearch";
import { OrgEngine, type OrgPaths } from "./organizer";
import { ConversationStore, makeSessionId } from "./conversation-store";

const TG_API = "https://api.telegram.org";

export interface BotConfig {
  token: string;
  store: MemStore;
  processorPaths?: ProcessorPaths;
  orgPaths?: OrgPaths;
  peers?: string[]; // Tailscale IPs of peer memory API servers
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: any;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number; first_name?: string; username?: string };
  entities?: { type: string; offset: number; length: number }[];
}

export class TelegramBot {
  private token: string;
  private store: MemStore;
  private offset = 0;
  private running = false;
  private chatId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseInterval = 2000;
  private maxInterval = 30_000;
  private curInterval = 2000;
  private emptyCount = 0;
  private idle = false;
  private processor: IdleProcessor | null = null;
  private procTimer: ReturnType<typeof setTimeout> | null = null;
  private hasWork = false;
  private organizer: OrgEngine | null = null;
  private peers: string[] = [];
  private conv: ConversationStore;
  private pollCount = 0;
  private lastGovInfo = "";

  constructor(cfg: BotConfig) {
    this.token = cfg.token;
    this.store = cfg.store;
    this.peers = cfg.peers ?? [];
    this.conv = new ConversationStore(undefined, (prompt) =>
      this.store.qwenAsk("", prompt),
    );
    this.conv.init().catch((err) => {
      console.error("[bot] 對話歷史初始化失敗:", (err as Error).message);
    });
    if (cfg.processorPaths)
      this.processor = new IdleProcessor(cfg.processorPaths);
    if (cfg.orgPaths)
      this.organizer = new OrgEngine(cfg.store, cfg.orgPaths, (s, m) =>
        this.store.qwenAsk(s, m),
      );
  }

  getChatId(): number {
    return this.chatId;
  }

  // ── 自適應輪詢 ──
  // 有工作時密集輪詢，無工作時逐步降頻待命

  async start(pollIntervalMs = 2000): Promise<void> {
    this.baseInterval = pollIntervalMs;
    this.curInterval = pollIntervalMs;
    this.running = true;
    console.log(`[telegram-memory] Bot 啟動 (base=${this.baseInterval}ms)`);
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.stopIdleProcessing();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll(), this.curInterval);
  }

  // ── 事件驅動背景處理 ──
  // 「有工作就做，沒工作就睡」— 不固定輪詢，只靠事件觸發

  /** 外部通知有異動（被 watcher / store / organize 觸發） */
  notifyWork(): void {
    this.hasWork = true;
    if (this.idle) this.runProcessCycle();
  }

  private startIdleProcessing(): void {
    if (!this.processor) return;
    console.log("[telegram-memory] 🌀 啟動背景資料處理");
    this.hasWork = true;
    this.runProcessCycle();
  }

  private stopIdleProcessing(): void {
    if (this.procTimer) {
      clearTimeout(this.procTimer);
      this.procTimer = null;
    }
  }

  private async runProcessCycle(): Promise<void> {
    if (!this.idle || !this.processor) return;
    if (!this.hasWork) return; // 沒工作繼續睡

    this.hasWork = false;
    const report = await this.processor.runOnce();
    console.log(`[telegram-memory] ${report}`);

    // 只在第一輪或有問題時推送 Telegram
    if (this.chatId) {
      const lines = report.split("\n");
      const hasIssues = lines.some((l) => l.includes("⚠️"));
      if (this.processor.cycle === 1) {
        const summary = lines.slice(0, 4).join("\n");
        this.sendMessage(`💤 背景資料處理\n\n${summary}`).catch(() => {});
      } else if (hasIssues) {
        this.sendMessage(
          `⚠️ 背景處理發現問題\n\n${report.slice(0, 500)}`,
        ).catch(() => {});
      }
    }

    // 不自動排程 — 等下一次 notifyWork() 喚醒
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const updates = await this.api("getUpdates", {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      const hasUpdates =
        updates?.ok &&
        Array.isArray(updates?.result) &&
        updates.result.length > 0;
      if (hasUpdates) {
        for (const u of updates.result as TgUpdate[]) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u);
        }
        // 有訊息 → 恢復活躍
        this.emptyCount = 0;
        if (this.idle) {
          this.idle = false;
          this.curInterval = this.baseInterval;
          this.stopIdleProcessing();
          console.log(
            `[telegram-memory] 📨 恢復活躍 (interval=${this.curInterval}ms)`,
          );
        }
      } else {
        // 無訊息 → 逐步降頻
        this.emptyCount++;
        if (this.emptyCount >= 3) {
          const next = Math.min(
            this.baseInterval * Math.pow(2, this.emptyCount - 2),
            this.maxInterval,
          );
          if (next !== this.curInterval) {
            this.curInterval = next;
            if (!this.idle) {
              this.idle = true;
              console.log(
                `[telegram-memory] 💤 進入待命 (interval=${this.curInterval}ms)`,
              );
              this.startIdleProcessing();
            }
          }
        }
      }
    } catch (err) {
      console.error("[telegram-memory] Poll error:", (err as Error).message);
    }

    // Governor 動態調速：每輪檢査，資訊改變或每 10 輪顯示
    this.pollCount++;
    const gov = suggest();
    if (gov.pollMs !== this.baseInterval || gov.info !== this.lastGovInfo) {
      this.baseInterval = gov.pollMs;
      this.lastGovInfo = gov.info;
      if (this.pollCount % 10 === 1 || this.emptyCount === 0)
        console.log(`[governor] ${gov.info}`);
    }
    // 若 governor 建議降頻且目前閒置中，直接套用
    if (this.idle && gov.pollMs > this.curInterval)
      this.curInterval = gov.pollMs;

    this.scheduleNext();
  }

  // ── Handle updates ──

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;
    if (!this.chatId) this.chatId = msg.chat.id;

    // 記錄使用者訊息到對話歷史（過濾閒聊）
    const sid = makeSessionId("telegram", msg.chat.id);
    this.conv
      .recordMsg(sid, "user", msg.text, "telegram", undefined, true)
      .catch(() => {});

    // check for commands (bot commands or direct messages)
    const text = msg.text.trim();
    const isCmd = msg.entities?.some((e) => e.type === "bot_command");

    if (isCmd) {
      await this.handleCommand(text, msg);
    } else {
      // non-command: treat as memory store attempt
      await this.handleMessage(text, msg);
    }
  }

  // ── Commands ──

  private async handleCommand(text: string, msg: TgMessage): Promise<void> {
    const [cmd, ...args] = text.split(/\s+/);
    const argStr = args.join(" ");

    switch (cmd) {
      case "/remember":
      case "/save":
        if (!argStr) {
          await this.reply(msg, "用法: /remember <內容>\n儲存一則記憶");
          return;
        }
        await this.doCmdRemember(argStr, msg);
        break;

      case "/ask":
        if (!argStr) {
          await this.reply(msg, "用法: /ask <問題>\nAI 根據記憶回答問題");
          return;
        }
        await this.doCmdAsk(argStr, msg);
        break;

      case "/recall":
      case "/search":
        if (!argStr) {
          await this.reply(msg, "用法: /recall <關鍵字>\n搜尋記憶");
          return;
        }
        await this.doCmdRecall(argStr, msg);
        break;

      case "/list":
        await this.doCmdList(msg);
        break;

      case "/stats":
        await this.doCmdStats(msg);
        break;

      case "/model":
        await this.doCmdModel(argStr, msg);
        break;

      case "/websearch":
      case "/google":
        if (!argStr) {
          await this.reply(msg, "用法: /websearch <查詢>\n搜尋網路，回傳結果");
          return;
        }
        await this.doCmdWebSearch(argStr, msg);
        break;

      case "/organize":
        await this.doCmdOrganize(msg);
        break;

      case "/progress":
        await this.doCmdProgress(msg);
        break;

      case "/webfetch":
      case "/fetch":
        if (!argStr) {
          await this.reply(msg, "用法: /webfetch <網址>\n擷取網頁內容");
          return;
        }
        await this.doCmdWebFetch(argStr, msg);
        break;

      case "/history":
        await this.doCmdHistory(args, msg);
        break;

      case "/status":
      case "/summary":
        await this.doCmdStatus(msg);
        break;

      case "/sync":
        await this.reply(msg, "🔄 同步中...");
        const state = await this.store.readSyncState();
        state.lastSync = new Date().toISOString();
        await this.store.writeSyncState(state);
        await this.reply(
          msg,
          `✅ 同步完成 (${state.syncedIds.length} 筆已同步)`,
        );
        break;

      case "/help":
        await this.reply(
          msg,
          [
            "📖 *Telegram Memory Bridge 指令*",
            "",
            "`/remember <內容>` — 儲存記憶",
            "`/ask <問題>` — AI 根據記憶回答（語意搜尋）",
            "`/recall <關鍵字>` — 搜尋記憶",
            "`/list` — 列出所有記憶",
            "`/stats` — 記憶統計",
            "`/status` — 資料概況（記憶+知識庫+維基）",
            "`/history` — 列出最近對話（加關鍵字可搜尋）",
            "`/history summary <id>` — 顯示對話詳細摘要",
            "`/history from=2026-06-01` — 依日期過濾",
            "`/model` — 查看當前模型，`/model <名稱>` 切換",
            "`/websearch <查詢>` — 搜尋網路（DuckDuckGo，免 API Key）",
            "`/webfetch <網址>` — 擷取網頁內容並摘要",
            "`/organize` — 自動整理舊資料（記憶+知識庫）→ SOP",
            "`/progress` — 查看整理進度",
            "`/sync` — 觸發同步",
            "`/help` — 顯示此說明",
            "",
            "💡 直接傳送文字也會自動儲存為記憶",
            "💡 `/websearch` 支援 Qwen AI 摘要搜尋結果",
            "💡 `/webfetch` 自動摘要網頁，無需手動閱讀",
          ].join("\n"),
        );
        break;

      default:
        // treat unrecognized commands as search
        if (argStr) {
          await this.doCmdRecall(text.slice(1), msg);
        } else {
          await this.reply(msg, `未知指令: ${cmd}。輸入 /help 查看可用指令`);
        }
    }
  }

  private async doCmdRemember(text: string, msg: TgMessage): Promise<void> {
    try {
      const result = await this.store.store(text);
      await this.reply(msg, `✅ 已儲存記憶 \`${result.id}\``);
      this.notifyWork(); // 有工作 → 觸發背景處理
    } catch (err) {
      await this.reply(msg, `❌ 儲存失敗: ${(err as Error).message}`);
    }
  }

  private async doCmdAsk(question: string, msg: TgMessage): Promise<void> {
    await this.reply(msg, "🤔 正在搜尋記憶並分析...");
    try {
      const [localResult, peerResults] = await Promise.all([
        this.store.searchByModel(question, 5),
        this.queryPeerRecall(question, 5),
      ]);

      const hasLocal = localResult.entries.length > 0;
      const hasPeer = peerResults.length > 0;

      if (!hasLocal && !hasPeer) {
        await this.reply(
          msg,
          "🔍 找不到相關記憶來回答這個問題。\n試試用 /remember 先儲存一些資訊。",
        );
        return;
      }

      const parts: string[] = [];
      if (hasLocal) {
        parts.push(
          "【本機記憶】\n" +
            localResult.entries
              .map(
                (e, i) =>
                  `[${i + 1}] 摘要: ${e.summary}\n    分類: ${e.category} | 相關度: ${e.score}%`,
              )
              .join("\n\n"),
        );
      }
      for (const pr of peerResults) {
        const peerLabel = pr.peer.includes("100.116.204.53")
          ? "筆電"
          : pr.peer.replace(/https?:\/\//, "").replace(/:\d+/, "");
        parts.push(
          `【${peerLabel}】\n` +
            pr.entries
              .map(
                (e, i) =>
                  `[${i + 1}] 摘要: ${e.summary}\n    分類: ${e.category}`,
              )
              .join("\n\n"),
        );
      }

      const total =
        localResult.total +
        peerResults.reduce((s, p) => s + p.entries.length, 0);
      const memoryText = parts.join("\n\n---\n\n");

      const system =
        "你是一個記憶助手，負責根據使用者儲存的記憶來回答問題。" +
        "記憶可能來自多台裝置（本機/筆電等）。" +
        "請根據提供的記憶內容回答。如果記憶不足，誠實告知不確定。" +
        "保持簡潔，用繁體中文，必要時可條列說明。";

      const userPrompt = [
        `以下是我儲存的相關記憶（共 ${total} 筆）：`,
        "",
        memoryText,
        "",
        "---",
        `問題：${question}`,
      ].join("\n");

      const answer = await this.store.qwenAsk(system, userPrompt);
      const preview =
        answer.length > 1500 ? answer.slice(0, 1500) + "…" : answer;
      await this.reply(msg, `💡 *回答*\n\n${preview}`);
    } catch (err) {
      await this.reply(
        msg,
        `❌ 分析失敗: ${(err as Error).message}\n可用 /recall 進行關鍵字搜尋`,
      );
    }
  }

  private async doCmdRecall(query: string, msg: TgMessage): Promise<void> {
    try {
      // Try model-powered search first, fall back to keyword
      let localResult;
      try {
        localResult = await this.store.searchByModel(query, 10);
        if (localResult.entries.length === 0) {
          localResult = await this.store.recall(query);
        }
      } catch {
        localResult = await this.store.recall(query);
      }

      // 並行查詢 peer 端記憶
      const peerResults = await this.queryPeerRecall(query, 10);

      const hasLocal = localResult.entries.length > 0;
      const hasPeer = peerResults.length > 0;

      if (!hasLocal && !hasPeer) {
        await this.reply(msg, "🔍 找不到相關記憶");
        return;
      }

      const lines: string[] = [];

      // 本地結果
      if (hasLocal) {
        lines.push("📌 *本機記憶*");
        for (const e of localResult.entries.slice(0, 10)) {
          const dev = e.device ? ` @${e.device}` : "";
          lines.push(
            `${lines.length + 1}. [${e.category}] ${e.summary} (${(e.score * 100).toFixed(0)}%)${dev}`,
          );
        }
      }

      // Peer 結果
      for (const pr of peerResults) {
        const peerLabel = pr.peer.includes("100.116.204.53")
          ? "筆電"
          : pr.peer.replace(/https?:\/\//, "").replace(/:\d+/, "");
        lines.push(`\n📡 *${peerLabel}*`);
        for (const e of pr.entries.slice(0, 5)) {
          const dev = e.device ? ` @${e.device}` : "";
          const score =
            e.score !== undefined ? ` (${(e.score * 100).toFixed(0)}%)` : "";
          lines.push(
            `${lines.length + 1}. [${e.category}] ${e.summary}${score}${dev}`,
          );
        }
      }

      const total =
        localResult.total +
        peerResults.reduce((s, p) => s + (p.entries.length || 0), 0);
      await this.reply(
        msg,
        `🔍 *搜尋結果* (共 ${total} 筆相關)\n\n${lines.join("\n")}`,
      );
    } catch (err) {
      await this.reply(msg, `❌ 搜尋失敗: ${(err as Error).message}`);
    }
  }

  private async doCmdList(msg: TgMessage): Promise<void> {
    const entries = await this.store.list();
    if (entries.length === 0) {
      await this.reply(msg, "📭 尚無記憶");
      return;
    }
    const lines = entries.map(
      (e) => `• \`${e.id}\` [${e.category}] ${e.summary}`,
    );
    const chunks = chunkArray(lines, 15);
    for (const chunk of chunks) {
      await this.reply(
        msg,
        `📋 *記憶清單* (共 ${entries.length} 筆)\n\n${chunk.join("\n")}`,
      );
    }
  }

  private async doCmdModel(arg: string, msg: TgMessage): Promise<void> {
    if (!arg) {
      const cur = this.store.getModel();
      await this.reply(
        msg,
        `🤖 *當前模型*: \`${cur}\`\n\n` +
          `用法: \`/model <名稱>\` 切換模型\n` +
          `範例: \`/model Qwen3.7-Max-thinking\``,
      );
      return;
    }
    this.store.setModel(arg.trim());
    await this.reply(msg, `✅ 模型已切換為 \`${arg.trim()}\``);
  }

  private async doCmdHistory(args: string[], msg: TgMessage): Promise<void> {
    try {
      const conv = new ConversationStore();
      await conv.init();

      // /history summary <sessionId> — 顯示詳細摘要
      if (args.length >= 2 && args[0] === "summary") {
        const sid = args[1];
        const session = await conv.getSession(sid);
        if (session.length === 0) {
          await this.reply(msg, `📭 找不到對話: \`${sid}\``);
          return;
        }
        // 嘗試讀取 AI 摘要
        let detail = await conv.getSessionSummary(sid);
        // 若無摘要且未達最小訊息數，提示使用者
        if (!detail && session.length < 10) {
          await this.reply(
            msg,
            `📄 \`${sid}\` (${session.length} 則)\n對話過短，暫無摘要（需至少 10 則）`,
          );
          return;
        }
        // 若無摘要，即時生成
        if (!detail) {
          await this.reply(msg, `⏳ 正在生成摘要: \`${sid}\`...`);
          detail = await conv.summarizeSession(sid);
          if (!detail) {
            await this.reply(msg, `❌ 摘要生成失敗`);
            return;
          }
        }
        const lines = [
          `📄 *${sid}*`,
          ``,
          `🎯 目的: ${detail.purpose || "未歸納"}`,
        ];
        if (detail.keyPoints?.length > 0) {
          lines.push(``, `🔑 *關鍵重點*`);
          for (const kp of detail.keyPoints.slice(0, 5)) lines.push(`• ${kp}`);
        }
        if (detail.decisions?.length > 0) {
          lines.push(``, `💡 *決定*`);
          for (const d of detail.decisions.slice(0, 5)) lines.push(`• ${d}`);
        }
        if (detail.files?.length > 0) {
          lines.push(``, `📁 *涉及檔案*`);
          for (const f of detail.files.slice(0, 8)) lines.push(`• \`${f}\``);
        }
        if (detail.commands?.length > 0) {
          lines.push(``, `⚡ *執行命令*`);
          for (const c of detail.commands.slice(0, 5)) lines.push(`• \`${c}\``);
        }
        if (detail.tags?.length > 0) {
          lines.push(``, `🏷️ ${detail.tags.join("、")}`);
        }
        await this.reply(msg, lines.join("\n"));
        return;
      }

      // 解析日期過濾與 limit
      const parsed: { from?: string; to?: string; limit?: number } = {};
      const searchTerms: string[] = [];
      for (const a of args) {
        if (a.startsWith("from=")) parsed.from = a.slice(5);
        else if (a.startsWith("to=")) parsed.to = a.slice(3);
        else if (a.startsWith("limit="))
          parsed.limit = parseInt(a.slice(6)) || 10;
        else searchTerms.push(a);
      }
      const query = searchTerms.join(" ");

      if (query) {
        // 關鍵字搜尋
        await this.reply(msg, `🔍 搜尋對話: "${query}"...`);
        const results = await conv.search(query, { limit: parsed.limit || 5 });
        if (results.length === 0) {
          await this.reply(msg, "📭 找不到相關對話紀錄");
          return;
        }
        const parts = [`🔍 *對話搜尋: ${query}*\n`];
        for (const r of results.slice(0, 3)) {
          parts.push(`📄 \`${r.sessionId}\``);
          for (const m of r.matches.slice(0, 3)) {
            const role = m.role === "user" ? "👤" : "🤖";
            const txt = (m.content || "").slice(0, 200);
            parts.push(`${role} ${txt}`);
          }
          parts.push("");
        }
        parts.push(`共 ${results.length} 個 session 匹配`);
        await this.reply(msg, parts.join("\n"));
      } else {
        // 列出最近 session
        let sessions = await conv.listSessions({ limit: 50 });
        // 日期過濾
        if (parsed.from)
          sessions = sessions.filter((s) => s.date >= parsed.from!);
        if (parsed.to) sessions = sessions.filter((s) => s.date <= parsed.to!);
        sessions = sessions.slice(0, parsed.limit || 10);

        if (sessions.length === 0) {
          await this.reply(msg, "📭 尚無對話紀錄");
          return;
        }
        const lines = sessions.map((s, i) => {
          let line = `${i + 1}. \`${s.id}\` (${s.msgCount} 則, ${s.date})`;
          if (s.summary) line += `\n   📝 ${s.summary.slice(0, 80)}`;
          return line;
        });
        const dateHint =
          parsed.from || parsed.to
            ? ` (${parsed.from || "..."} ~ ${parsed.to || "..."})`
            : "";
        await this.reply(
          msg,
          `📋 *最近對話*${dateHint}\n\n${lines.join("\n")}\n\n搜尋: /history <關鍵字>\n摘要: /history summary <id>`,
        );
      }
    } catch (err) {
      await this.reply(msg, `❌ 查詢失敗: ${(err as Error).message}`);
    }
  }

  private async doCmdStatus(msg: TgMessage): Promise<void> {
    // 即時執行處理器回報摘要到電報
    if (!this.processor) {
      await this.reply(msg, "⚠️ 背景處理器未啟用（無路徑配置）");
      return;
    }
    await this.reply(msg, "⏳ 正在掃描記憶/知識庫/維基...");
    const report = await this.processor.runOnce();
    const lines = report.split("\n");
    // 摘要只取前幾行，避免 Telegram 訊息過長
    const summary = lines.slice(0, 4).join("\n");
    const detail = lines.slice(4).filter((l) => l.trim());
    let body = summary;
    if (detail.length > 0) body += "\n\n" + detail.slice(0, 8).join("\n");
    if (detail.length > 8) body += `\n  ... 還有 ${detail.length - 8} 項`;
    await this.reply(msg, `📊 *資料概況*\n\n${body}`);
  }

  private async doCmdStats(msg: TgMessage): Promise<void> {
    const s = await this.store.stats();
    const catStr = Object.entries(s.byCategory)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    await this.reply(
      msg,
      [
        `📊 *記憶統計*`,
        ``,
        `總數: ${s.total}`,
        `分類:`,
        catStr || "  無",
        `重要性: 高${s.byImportance.high} / 中${s.byImportance.mid} / 低${s.byImportance.low}`,
        `最後同步: ${s.lastSync || "從未"}`,
      ].join("\n"),
    );
  }

  // ── Organize (自動整理舊資料 → SOP) ──

  private async doCmdOrganize(msg: TgMessage): Promise<void> {
    if (!this.organizer) {
      await this.reply(msg, "⚠️ 組織器未啟用（無路徑配置）");
      return;
    }
    if (this.organizer.isRunning()) {
      await this.reply(msg, "⏳ 整理工作已在進行中，用 /progress 查看進度");
      return;
    }
    await this.reply(
      msg,
      "🚀 開始整理舊資料（記憶+知識庫→SOP）...\n這需要一些時間，完成後會通知。\n可用 /progress 查看進度。",
    );
    const result = await this.organizer.start();
    await this.sendMessage(`📋 *整理報告*\n\n${result}`);
    this.notifyWork(); // SOP 檔案寫入 → 觸發索引更新
  }

  // ── Progress ──

  private async doCmdProgress(msg: TgMessage): Promise<void> {
    if (!this.organizer) {
      await this.reply(msg, "⚠️ 組織器未啟用（無路徑配置）");
      return;
    }
    const p = this.organizer.getProgress();
    if (p.phase === "idle") {
      await this.reply(msg, "💤 尚未執行過整理。用 /organize 開始。");
      return;
    }
    const statusEmoji: Record<string, string> = {
      idle: "💤",
      "scanning-memory": "📖",
      "scanning-knowledge": "📚",
      classifying: "🧠",
      generating: "✍️",
      indexing: "🔗",
      done: "✅",
      paused: "⏸",
      stopped: "⏹",
    };
    const phaseLabel: Record<string, string> = {
      counting: "計算總數",
      "scanning-memory": "掃描記憶",
      "scanning-knowledge": "掃描知識庫",
      classifying: "AI 分類中",
      generating: "生成 SOP",
      indexing: "更新索引",
      done: "已完成",
    };
    const emoji = statusEmoji[p.phase] || "❓";
    const label = phaseLabel[p.phase] || p.phase;
    const running = p.running ? "🟢 進行中" : "⏸ 已停止";
    const elapsed = p.startedAt
      ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000) + "s"
      : "-";
    const lastLog = p.log.length > 0 ? p.log[p.log.length - 1] : "無";

    await this.reply(
      msg,
      [
        `${emoji} *整理進度*`,
        ``,
        `狀態: ${running}`,
        `階段: ${label}`,
        `經過: ${elapsed}`,
        `掃描: ${p.scanned}/${p.total}`,
        `SOP 新建: ${p.sopCreated}`,
        `SOP 更新: ${p.sopUpdated}`,
        `跳過: ${p.skipped}`,
        `錯誤: ${p.errors}`,
        ``,
        `最新: ${lastLog}`,
      ].join("\n"),
    );
  }

  // ── Web Search ──

  private async doCmdWebSearch(query: string, msg: TgMessage): Promise<void> {
    await this.reply(msg, "🔍 正在搜尋網路...");
    try {
      const results = await webSearch(query, 5);
      if (results.length === 0) {
        await this.reply(msg, "🔍 找不到相關結果");
        return;
      }

      // 嘗試用 Qwen 摘要
      let summary = "";
      try {
        summary = await summarizeWithQwen(
          (s, u) => this.store.qwenAsk(s, u),
          query,
          results,
        );
      } catch {
        /* AI 摘要失敗沒關係 */
      }

      const lines = results.map(
        (r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`,
      );

      const body = summary
        ? [`💡 *摘要*\n${summary}`, "", "━━━ 來源 ━━━", ...lines].join("\n")
        : lines.join("\n\n");

      const truncated =
        body.length > 3800
          ? body.slice(0, 3800) + "\n\n… 內容過長已截斷"
          : body;
      await this.reply(msg, `🌐 *網路搜尋: ${query}*\n\n${truncated}`);
    } catch (err) {
      await this.reply(msg, `❌ 搜尋失敗: ${(err as Error).message}`);
    }
  }

  // ── Web Fetch ──

  private async doCmdWebFetch(url: string, msg: TgMessage): Promise<void> {
    await this.reply(msg, "⏳ 正在擷取網頁...");
    try {
      const text = await webFetch(url, 3000);

      // 嘗試用 Qwen 摘要
      let summary = text;
      try {
        const sys =
          "摘要以下網頁內容，保留關鍵資訊，使用繁體中文，保持在 500 字內。";
        summary = await this.store.qwenAsk(sys, text);
      } catch {
        /* AI 摘要失敗就顯示原始文字 */
      }

      const preview =
        summary.length > 3500
          ? summary.slice(0, 3500) + "\n\n… 內容過長已截斷"
          : summary;

      await this.reply(msg, `📄 *網頁內容*\n\`${url}\`\n\n${preview}`);
    } catch (err) {
      await this.reply(msg, `❌ 擷取失敗: ${(err as Error).message}`);
    }
  }

  // ── 呼叫 AI 回應 ──

  private async askAI(text: string): Promise<string | null> {
    try {
      // 先找相關記憶
      const related = await this.store.searchByModel(text, 5);
      const memoryText = related.entries
        .map((e, i) => `[${i + 1}] ${e.summary} (${e.category})`)
        .join("\n");

      const system =
        "你是一個智能助手，名為 OpenCode。根據使用者訊息與相關記憶回答。" +
        "若需要可參考記憶內容，但不要說你是根據記憶回答。保持簡潔、繁體中文。" +
        "如果使用者問的是即時資訊（時間、天氣等），誠實告知不確定。";

      const prompt = memoryText
        ? `相關記憶：\n${memoryText}\n\n---\n\n${text}`
        : text;

      return await this.store.qwenAsk(system, prompt);
    } catch {
      return null;
    }
  }

  // ── 查詢 peer 端記憶（Tailscale 網路內的 API server）──

  private async queryPeerRecall(
    query: string,
    limit = 5,
  ): Promise<{ peer: string; entries: any[] }[]> {
    if (this.peers.length === 0) return [];
    const results: { peer: string; entries: any[] }[] = [];
    await Promise.allSettled(
      this.peers.map(async (base) => {
        const url = `${base.replace(/\/+$/, "")}/api/recall?q=${encodeURIComponent(query)}&limit=${limit}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: any[]; total?: number };
        if (data.entries && data.entries.length > 0)
          results.push({ peer: base, entries: data.entries });
      }),
    );
    return results;
  }

  private async queryPeerList(): Promise<{ peer: string; entries: any[] }[]> {
    if (this.peers.length === 0) return [];
    const results: { peer: string; entries: any[] }[] = [];
    await Promise.allSettled(
      this.peers.map(async (base) => {
        const url = `${base.replace(/\/+$/, "")}/api/list`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: any[]; total?: number };
        if (data.entries && data.entries.length > 0)
          results.push({ peer: base, entries: data.entries });
      }),
    );
    return results;
  }

  // ── AI 分類：判斷訊息類型 - 是否儲存 / 是否需要查記憶回答 ──
  // 回傳 null = 分類失敗（應視為安全預設，不遺失資料）

  private async classifyMessage(text: string): Promise<{
    store: boolean;
    category?: string;
    importance?: number;
    tags?: string[];
    summary?: string;
    /** 使用者是否在詢問/查東西，需要查記憶回答 */
    needsAnswer?: boolean;
    /** 使用者想知道即時/最新/網路資訊，需要搜尋網路 */
    needsWebSearch?: boolean;
    /** 是否為詐騙/可疑訊息 */
    isScam?: boolean;
    /** 詐騙類型 */
    scamType?: string;
    /** 風險評分 0-100 */
    riskScore?: number;
  } | null> {
    const system = [
      "你是一個智慧分類器。分析使用者訊息，回傳 JSON。",
      "",
      "一、是否值得儲存為長期記憶（store）：",
      "true 值得儲存的類型：",
      "- 事實（fact）：技術知識、設定、安裝步驟、配置參數",
      "- 偏好（preference）：使用者喜好、習慣、工作流偏好",
      "- 決策（decision）：已做的決定、規則、方針",
      "- 事件（event）：重要事件、完成進度、測試結果",
      "- 實體（entity）：專案/檔案/服務的相關資訊",
      "- 模式（pattern）：重複行為、規律、常見問題",
      "false 不值得儲存：打招呼/告別、單字回覆（好/ok/謝謝）、閒聊、確認、語氣詞",
      "",
      "二、使用者是否在詢問/查東西（needsAnswer）：",
      "true 包含：問問題、查資料、找記憶、請求說明、詢問狀態、打聽資訊",
      "false 包含：閒聊、打招呼、指令、單純告知",
      "",
      "三、使用者是否需要搜尋網路取得即時資訊（needsWebSearch）：",
      "true 包含：搜尋/查詢某個關鍵字、問最新消息/新聞/目前狀況/即時資訊、",
      "  關鍵字如「搜一下」「查一下」「最新」「新聞」「今天」「目前」「即時」「2025/2026」搭配疑問句",
      "  使用者想知道目前/最新的狀況，而非從既有記憶找答案",
      "false 包含：閒聊、打招呼、單純告知、從記憶找答案的詢問",
      "",
      "四、詐騙偵測（isScam + riskScore 0-100）：判斷訊息/簡訊/郵件/網址是否為詐騙",
      "",
      "【簡訊詐騙 SMS】偽裝銀行/電信/物流通知（「您的包裹已到達」「帳戶異常」）、",
      "  假冒電商要求補填資料、簡訊含可疑短網址（bit.ly, reurl.cc 等）、要求回撥陌生付費電話",
      "",
      "【郵件詐騙 Email】偽造寄件人地址（spoofing）、假冒官方（paypal/google/apple/銀行）、",
      "  緊急語氣（「您的帳號將被停用」「有人嘗試登入您的帳戶」）、附帶惡意附件",
      "",
      "【即時訊息詐騙 IM/Line/Telegram】假冒親友借錢、群組投資邀請、免費貼圖/優惠連結、",
      "  假冒客服要求提供OTP、偽裝成官方帳號發送中獎通知",
      "",
      "【網址詐騙 URL】短網址隱藏真實目標、仿冒域名（go0gle.com, faceboook.com）、",
      "  包含 suspicious TLD（.xyz, .top, .loan）、含一頁式釣魚頁面要求輸入帳密",
      "",
      "【共通特徵】緊急/威脅用語（立即/馬上/即將關閉）、個資索取（密碼/OTP/身分證）、",
      "  金錢要求（匯款/保證金/手續費）、權威冒充（警察/檢察官/銀行）、異常連結、文法錯誤",
      "",
      "true 時提供 riskScore（>=80 極高, 60-79 高, 40-59 中, <40 低）",
      "scamType：phishing（釣魚）, lottery（中獎）, investment（投資）, impersonation（假冒）,",
      "  sms（簡訊詐騙）, emailScam（郵件詐騙）, fakePromo（假優惠）, socialEngineering（社交工程）, other",
      '  tags 包含詐騙特徵標籤如 ["假冒銀行","短網址","緊急語氣"]',
      "false 正常訊息，riskScore 設 0",
      "",
      "回傳 JSON，格式：",
      '{"store":false,"needsAnswer":false,"needsWebSearch":false,"isScam":false,"riskScore":0}',
      '{"store":false,"needsAnswer":false,"needsWebSearch":false,"isScam":true,"scamType":"sms","riskScore":85,"summary":"假冒銀行簡訊要求驗證帳戶含短網址","tags":["假冒銀行","短網址"]}',
    ].join("\n");

    const prompt = `訊息：${text}\n\n分類並回傳 JSON。`;

    try {
      const answer = await this.store.qwenAsk(system, prompt);
      const cleaned = answer
        .replace(/```(?:json)?\n?/g, "")
        .replace(/\n?```/g, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) return null;
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null; // 分類失敗 → 安全預設
    }
  }

  // ── Non-command message ──

  private async handleMessage(text: string, msg: TgMessage): Promise<void> {
    // 先 AI 分類：詐騙偵測 + 意圖判斷
    const cls = await this.classifyMessage(text);

    // ── 詐騙偵測優先 ⚠️ ──
    if (cls?.isScam) {
      const typeLabel: Record<string, string> = {
        phishing: "釣魚連結",
        lottery: "假冒中獎",
        investment: "投資詐騙",
        impersonation: "假冒身份",
        sms: "簡訊詐騙",
        emailScam: "郵件詐騙",
        fakePromo: "假優惠",
        socialEngineering: "社交工程",
        other: "可疑訊息",
      };
      const label = typeLabel[cls.scamType || "other"] || "可疑訊息";
      const score = cls.riskScore ?? 0;
      const level =
        score >= 80
          ? "🔴 極高風險"
          : score >= 60
            ? "🟠 高風險"
            : score >= 40
              ? "🟡 中等風險"
              : "🟢 低風險";
      const tags =
        Array.isArray(cls.tags) && cls.tags.length > 0
          ? `\n🏷️ 特徵：${cls.tags.join("、")}`
          : "";
      const warnText = [
        `⚠️ *${label}*`,
        `📊 風險評分：${score} — ${level}`,
        "",
        "❌ 請勿：點擊連結／回覆個資／轉帳／掃 QR",
        "✅ 建議：直接刪除並封鎖寄件人",
        cls.summary ? `\n🔍 分析：${cls.summary}` : "",
        tags,
      ].join("\n");
      await this.reply(msg, warnText);
      return;
    }

    // 分類失敗 + 詐騙關鍵字 heuristic 防護網
    if (cls === null) {
      const scamKws = [
        "中獎",
        "免費領取",
        "限時優惠",
        "立即點擊",
        "驗證帳號",
        "安全認證",
        "帳戶異常",
        "解除鎖定",
        "保證獲利",
        "投資穩賺",
        "無風險",
        "高報酬",
        "假冒",
        "官方通知",
        "點擊連結",
        "重設密碼",
        "收到這個",
        "轉發給",
        "急用錢",
        "借我",
        "line",
        "客服",
        "專員",
      ];
      const matched = scamKws.filter((k) => text.includes(k));
      if (matched.length >= 2) {
        await this.reply(
          msg,
          `⚠️ *可疑訊息警示*\n\n偵測到多個詐騙特徵（${matched.join("、")}），請提高警覺，不要點擊連結或回覆個資。`,
        );
        // 仍儲存紀錄供後續參考
        try {
          await this.store.store(text, {
            category: "security",
            importance: 0.9,
            tags: ["scam", "suspicious"],
          });
        } catch {
          /* ok */
        }
        return;
      }
    }

    // 使用者要求即時/網路資訊 → 優先搜尋網路，不儲存（查詢非知識）
    if (cls?.needsWebSearch) {
      await this.doCmdWebSearch(text, msg);
      return;
    }

    // 分類成功且判定為值得儲存 → 儲存記憶
    let id = "";
    if (cls?.store) {
      try {
        const result = await this.store.store(text, {
          category: cls.category,
          importance: cls.importance ?? 0.7,
          tags: cls.tags,
        });
        id = result.id;
        this.notifyWork(); // 有工作 → 觸發背景處理
      } catch (err) {
        await this.reply(msg, `❌ 儲存失敗: ${(err as Error).message}`);
        return;
      }
    } else if (cls === null) {
      // 分類失敗（AI 異常）→ 安全預設：照樣儲存，避免遺失資料
      try {
        const result = await this.store.store(text);
        id = result.id;
        this.notifyWork(); // 有工作 → 觸發背景處理
      } catch (err) {
        await this.reply(msg, `❌ 儲存失敗: ${(err as Error).message}`);
        return;
      }
    }
    // cls?.store === false → 不儲存（閒聊）

    // 使用者是來問問題/查資料 → 查記憶 + AI 回答
    if (cls?.needsAnswer || cls === null) {
      // 分類失敗時用關鍵字 heuristic 判斷是否要搜尋網路
      if (cls === null) {
        const kw = ["搜", "查", "最新", "新聞", "今天", "目前", "2025", "2026"];
        const hasKw = kw.some((k) => text.includes(k));
        if (
          hasKw &&
          (text.includes("嗎") || text.includes("？") || text.includes("?"))
        ) {
          await this.doCmdWebSearch(text, msg);
          return;
        }
      }
      await this.reply(msg, "⏳ 處理中...");
      const answer = await this.askAI(text);
      if (answer) {
        const preview =
          answer.length > 1500 ? answer.slice(0, 1500) + "…" : answer;
        await this.reply(msg, `💡 *回應*\n\n${preview}`);
        return;
      }
    }

    // 無詢問 → 根據是否儲存給不同回覆
    if (cls?.store) {
      await this.reply(msg, `✅ 已記錄 💾 (\`${id}\`)\n可用 /recall 搜尋`);
    } else if (cls === null) {
      await this.reply(msg, `✅ 已記錄 💾 (\`${id}\`)`);
    }
    // cls?.store === false && !needsAnswer → 閒聊不儲存不回覆
  }

  // ── Telegram API ──

  private async api(method: string, body: Record<string, any>): Promise<any> {
    const url = `${TG_API}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async reply(msg: TgMessage, text: string): Promise<void> {
    await this.api("sendMessage", {
      chat_id: msg.chat.id,
      text,
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    });
    // 記錄 bot 回覆到對話歷史
    const sid = makeSessionId("telegram", msg.chat.id);
    this.conv.recordMsg(sid, "assistant", text, "telegram").catch(() => {});
  }

  // ── Send proactive message ──

  async sendMessage(text: string): Promise<void> {
    if (!this.chatId) return;
    await this.api("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: "Markdown",
    });
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size)
    result.push(arr.slice(i, i + size));
  return result;
}
