// Telegram Memory Bridge — bot.ts
// Telegram Bot 處理 — 使用原生 fetch，零依賴

import type { MemStore } from "./store";
import { IdleProcessor, type ProcessorPaths } from "./processor";
import { suggest } from "./governor";
import { webSearch, webFetch, summarizeWithQwen } from "./websearch";
import { OrgEngine, type OrgPaths } from "./organizer";
import {
  ConversationStore,
  makeSessionId,
  type ConvSessionSummary,
} from "./conversation-store";
import {
  runTool,
  parseToolCommand,
  getRecentConversationContext,
} from "./tools";
import { initKnowledgeTools } from "./knowledge-tools";
import { searchDir } from "./api";

const TG_API = "https://api.telegram.org";

export interface BotConfig {
  token: string;
  store: MemStore;
  processorPaths?: ProcessorPaths;
  orgPaths?: OrgPaths;
  peers?: string[]; // Tailscale IPs of peer memory API servers
  knowledgePath?: string; // 知識庫目錄（自動帶入上下文）
  wikiPath?: string; // 維基目錄
  lessonPath?: string; // 經驗教訓目錄
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
  private pollErrCount = 0;
  private maxPollErrBackoff = 120_000;
  private knowledgePath = "";
  private wikiPath = "";
  private lessonPath = "";

  constructor(cfg: BotConfig) {
    this.token = cfg.token;
    this.store = cfg.store;
    this.peers = cfg.peers ?? [];
    this.knowledgePath = cfg.knowledgePath || "";
    this.wikiPath = cfg.wikiPath || "";
    this.lessonPath = cfg.lessonPath || "";
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
          // ⚡ 非同步處理，避免阻塞輪詢迴圈
          this.handleUpdate(u).catch((err) => {
            console.error("[bot] handleUpdate error:", (err as Error).message);
          });
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
      this.pollErrCount++;
      const backoff = Math.min(
        this.baseInterval * Math.pow(2, Math.min(this.pollErrCount, 5)),
        this.maxPollErrBackoff,
      );
      this.curInterval = Math.max(this.curInterval, backoff);
      console.error(
        `[telegram-memory] Poll error #${this.pollErrCount}: ${(err as Error).message} (backoff ${this.curInterval}ms)`,
      );
      this.scheduleNext();
      return; // skip governor/logic below, just retry later
    }
    this.pollErrCount = 0; // reset on success

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

    // P24: Fire-and-Forget 模式 — 將重任務移至下一個 Event Loop tick，避免阻塞輪詢
    if (isCmd) {
      Promise.resolve()
        .then(() => this.handleCommand(text, msg))
        .catch((err) => {
          console.error("[bot] handleCommand error:", (err as Error).message);
        });
    } else {
      // non-command: treat as memory store attempt
      Promise.resolve()
        .then(() => this.handleMessage(text, msg))
        .catch((err) => {
          console.error("[bot] handleMessage error:", (err as Error).message);
        });
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

      case "/run":
        if (!argStr) {
          await this.reply(
            msg,
            "用法: /run <工具> <參數>\n\n可用工具:\n`bash <指令>` — 執行 shell\n`read <路徑>` — 讀取檔案\n`write <路徑> | <內容>` — 寫入檔案\n`edit <路徑> | <舊字串> | <新字串>` — 編輯檔案\n`glob <模式> [目錄]` — 搜尋檔案\n`grep <模式> [目錄]` — 搜尋內容\n`history` — 查看當前對話歷史\n`skill <名稱> [參數]` — 調用技能（weather, summarize）\n\n範例: `/run bash ls -la`\n範例: `/run skill weather loc=Taipei`\n範例: `/run skill summarize url=https://example.com`",
          );
          return;
        }
        await this.doCmdRun(argStr, msg);
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
            "`/run <工具>` — 執行 opencode 工具（bash/read/write/edit/glob/grep/history/skill）",
            "`/websearch <查詢>` — 搜尋網路（Brave Search，免 API Key）",
            "`/webfetch <網址>` — 擷取網頁內容並摘要",
            "`/organize` — 自動整理舊資料（記憶+知識庫）→ SOP",
            "`/progress` — 查看整理進度",
            "`/sync` — 觸發同步",
            "`/help` — 顯示此說明",
            "",
            "💡 直接傳送文字也會自動儲存為記憶（閒聊除外）",
            "💡 `/websearch` 支援 AI 摘要搜尋結果",
            "💡 `/run history` 查看當前對話歷史上下文",
            "💡 `/run skill weather loc=台北` 查詢天氣",
            "💡 `/run skill summarize url=...` 摘要網頁",
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
    await this.reply(msg, "🤔 正在搜尋記憶、知識庫、維基與教訓...");
    try {
      const [localResult, peerResults] = await Promise.all([
        this.store.searchByModel(question, 5),
        this.queryPeerRecall(question, 5),
      ]);

      // 平行搜尋知識庫、維基、經驗教訓（關鍵詞全文比對）
      const [kHits, wHits, lHits] = await Promise.all([
        searchDir(this.knowledgePath, question, 3),
        searchDir(this.wikiPath, question, 3),
        searchDir(this.lessonPath, question, 3),
      ]);

      const hasLocal = localResult.entries.length > 0;
      const hasPeer = peerResults.length > 0;
      const hasKnow = kHits.length > 0;
      const hasWiki = wHits.length > 0;
      const hasLess = lHits.length > 0;

      const parts: string[] = [];
      if (hasLocal) {
        parts.push(
          "📝 *本機記憶*\n" +
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
      if (hasKnow) parts.push("📚 *相關知識庫*\n" + kHits.join("\n"));
      if (hasWiki) parts.push("📖 *相關維基*\n" + wHits.join("\n"));
      if (hasLess) parts.push("⚠️ *相關教訓*\n" + lHits.join("\n"));

      const total =
        localResult.total +
        peerResults.reduce((s, p) => s + p.entries.length, 0);
      const allText = parts.join("\n\n---\n\n");

      const system =
        "你是一個全知的開發助手。以下是與問題相關的記憶、知識庫、維基和經驗教訓。\n" +
        "請根據這些資訊回答，並在適當時引用來源。保持簡潔，用繁體中文，必要時可條列說明。\n\n" +
        "小提醒：\n" +
        "• 遇到問題解決後，可用 /run lesson_save 記錄經驗教訓\n" +
        "• 學到新技術或架構，可用 /run knowledge_save 存入知識庫\n" +
        "• 重要的長期文件，可用 /run wiki_save 建立維基條目";

      const userPrompt = [
        `以下是與問題相關的所有資料（共 ${total} 筆記憶 + 知識庫 ${kHits.length} 筆 + 維基 ${wHits.length} 筆 + 教訓 ${lHits.length} 筆）：`,
        "",
        allText,
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
        // 嘗試讀取 AI 摘要（優先使用結構化 detail）
        const idx = await conv.loadIdx();
        let detail = idx[sid]?.detail;

        // 若無結構化摘要，嘗試讀取舊版純文字摘要並轉換
        if (!detail && idx[sid]?.summary) {
          detail = {
            purpose: idx[sid].summary,
            keyPoints: [],
            decisions: [],
            files: [],
            commands: [],
            tags: [],
          };
        }

        // 若完全無摘要且未達最小訊息數，提示使用者
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
          const generated = await conv.summarizeSession(sid);
          if (!generated) {
            await this.reply(msg, `❌ 摘要生成失敗`);
            return;
          }
          detail = generated;
        }

        // 確保 detail 不為 null (TypeScript narrowing)
        const d = detail as ConvSessionSummary;
        const lines = [`📄 *${sid}*`, ``, `🎯 目的: ${d.purpose || "未歸納"}`];
        if (d.keyPoints && d.keyPoints.length > 0) {
          lines.push(``, `🔑 *關鍵重點*`);
          for (const kp of d.keyPoints.slice(0, 5)) lines.push(`• ${kp}`);
        }
        if (d.decisions && d.decisions.length > 0) {
          lines.push(``, `💡 *決定*`);
          for (const dec of d.decisions.slice(0, 5)) lines.push(`• ${dec}`);
        }
        if (d.files && d.files.length > 0) {
          lines.push(``, `📁 *涉及檔案*`);
          for (const f of d.files.slice(0, 8)) lines.push(`• \`${f}\``);
        }
        if (d.commands && d.commands.length > 0) {
          lines.push(``, `⚡ *執行命令*`);
          for (const c of d.commands.slice(0, 5)) lines.push(`• \`${c}\``);
        }
        if (d.tags && d.tags.length > 0) {
          lines.push(``, `🏷️ ${d.tags.join("、")}`);
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

  // ── /run opencode tool ──

  private async doCmdRun(text: string, msg: TgMessage): Promise<void> {
    const call = parseToolCommand(`/run ${text}`);
    if (!call) {
      await this.reply(
        msg,
        "❌ 無法解析指令。用法:\n`/run bash <指令>`\n`/run read <路徑>`\n`/run write <路徑> | <內容>`\n`/run edit <路徑> | <舊字串> | <新字串>`\n`/run glob <模式> [目錄]`\n`/run grep <模式> [目錄]`\n`/run history`\n`/run knowledge_save title=標題 content=內容 [category=分類] [tags=a,b,c]`\n`/run knowledge_read title=標題`\n`/run knowledge_index [category=分類] [limit=20]`\n`/run knowledge_deduplicate [threshold=0.9] [dryRun=true]`\n`/run lesson_save title=標題 scenario=情境 mistake=錯誤 [solution=解法]`\n`/run lesson_list [severity=P0-P4]`\n`/run wiki_save title=標題 content=內容 [category=分類]`\n`/run wiki_list [category=分類] [limit=20]`\n`/run wiki_read title=標題`",
      );
      return;
    }

    // 安全限制：僅允許特定目錄操作
    if (call.name === "bash" || call.name === "write" || call.name === "edit") {
      const restrictedDirs = ["/etc", "/sys", "/proc", "/boot", "/dev"];
      const argStr = JSON.stringify(call.args);
      for (const dir of restrictedDirs) {
        if (argStr.includes(dir)) {
          await this.reply(msg, `❌ 安全限制：不允許操作 ${dir} 目錄`);
          return;
        }
      }
    }

    await this.reply(msg, `⏳ 執行 \`${call.name}\`...`);

    try {
      const sid = makeSessionId("telegram", msg.chat.id);
      const result = await runTool(call, this.conv, sid);

      if (!result.ok && result.error) {
        await this.reply(
          msg,
          `❌ \`${call.name}\` 失敗\n\n${(result.output || result.error).slice(0, 1500)}`,
        );
        return;
      }

      const output = result.output.slice(0, 3500);
      if (!output) {
        await this.reply(msg, `✅ \`${call.name}\` 完成（無輸出）`);
        return;
      }

      await this.reply(
        msg,
        `✅ \`${call.name}\` 結果\n\n\`\`\`\n${output}\n\`\`\``,
      );
    } catch (e) {
      await this.reply(msg, `❌ 工具執行異常: ${(e as Error).message}`);
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

  // ── Organize (自動整理舊資料 → SOP，背景執行不卡 bot) ──

  private doCmdOrganize(msg: TgMessage): void {
    if (!this.organizer) {
      this.reply(msg, "⚠️ 組織器未啟用（無路徑配置）").catch(() => {});
      return;
    }
    if (this.organizer.isRunning()) {
      this.reply(msg, "⏳ 整理工作已在進行中，用 /progress 查看進度").catch(
        () => {},
      );
      return;
    }
    this.reply(
      msg,
      "🚀 開始整理舊資料（記憶+知識庫→SOP）...\n完成後會通知。\n可用 /progress 查看進度。",
    ).catch(() => {});
    // ⚡ fire-and-forget: 不 await，不阻塞 bot 輪詢
    this.organizer
      .start()
      .then((result) => {
        this.sendMessage(`📋 *整理報告*\n\n${result}`).catch(() => {});
        this.notifyWork();
      })
      .catch((err) => {
        console.error("[organizer] ❌ 整理失敗:", (err as Error).message);
        this.sendMessage(`❌ 整理失敗: ${(err as Error).message}`).catch(
          () => {},
        );
      });
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

  // ── 呼叫 AI 回應（含對話歷史上下文） ──

  private async askAI(text: string): Promise<string | null> {
    try {
      // 先找相關記憶
      const [related, convCtx] = await Promise.all([
        this.store.searchByModel(text, 5),
        getRecentConversationContext(
          this.conv,
          makeSessionId("telegram", this.chatId),
          20,
        ),
      ]);
      const memoryText = related.entries
        .map((e, i) => `[${i + 1}] ${e.summary} (${e.category})`)
        .join("\n");

      const system =
        "你是一個智能助手，名為 OpenCode。根據使用者訊息與相關記憶回答。" +
        "若需要可參考記憶內容，但不要說你是根據記憶回答。保持簡潔、繁體中文。" +
        "如果使用者問的是即時資訊（時間、天氣等），誠實告知不確定。" +
        (convCtx
          ? "\n\n以下為當前對話的近期歷史（供上下文參考）：\n" + convCtx
          : "");

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

  // ── 快速閒聊過濾（在 AI 分類前先擋掉明顯閒聊）──

  private isTrivialChat(text: string): boolean {
    const t = text.trim();
    // 極短訊息
    if (t.length < 5) return true;
    // 常見閒聊關鍵字
    const trivia = [
      "hi",
      "hello",
      "hey",
      "嗨",
      "哈囉",
      "你好",
      "好",
      "ok",
      "okay",
      "是的",
      "沒錯",
      "對",
      "謝謝",
      "感恩",
      "感謝",
      "thx",
      "thanks",
      "了解",
      "知道了",
      "明白",
      "收到",
      "get",
      "早安",
      "午安",
      "晚安",
      "bye",
      "再見",
      "😊",
      "👍",
      "👌",
      "✅",
      "🙏",
      "❤️",
      "😂",
    ];
    if (trivia.includes(t.toLowerCase())) return true;
    // 純表情符號
    if (/^[\p{Emoji}\s]+$/u.test(t)) return true;
    // 單字回覆
    if (t.split(/\s+/).length === 1 && t.length < 10) return true;
    return false;
  }

  // ── Non-command message ──

  private async handleMessage(text: string, msg: TgMessage): Promise<void> {
    // 快速過濾明顯閒聊（不進 AI 分類，不儲存，不回覆）
    if (this.isTrivialChat(text)) {
      // 僅記錄到對話歷史（供上下文），不儲存為記憶
      const sid = makeSessionId("telegram", msg.chat.id);
      this.conv
        .recordMsg(sid, "user", text, "telegram", undefined, false)
        .catch(() => {});
      // 閒聊也記錄 bot 的簡短回應到對話歷史
      const replies = ["👌", "✅", "😊", "收到"];
      const reply = replies[Math.floor(Math.random() * replies.length)];
      this.conv.recordMsg(sid, "assistant", reply, "telegram").catch(() => {});
      return;
    }

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
    }
    // cls === null 且非詐騙 → 視為閒聊，不儲存（改變原行為）
    // cls?.store === false → 不儲存（閒聊）

    // 使用者是來問問題/查資料 → 查記憶 + AI 回答
    if (cls?.needsAnswer) {
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
    } else if (!cls?.needsAnswer && !cls?.store) {
      // 非閒聊、非詐騙、非詢問、非儲存 → 視為一般對話，給予簡短回應並記錄重點
      const sid = makeSessionId("telegram", msg.chat.id);
      this.conv.recordMsg(sid, "user", text, "telegram").catch(() => {});

      // AI 生成簡短回應與重點摘要
      try {
        const sys =
          "你是一個簡潔的助手。對使用者的訊息給予簡短回應（1-2句），並提取一個重點標籤（如：確認、進度、想法）。回傳 JSON: {reply: string, tag: string}";
        const raw = await this.store.qwenAsk(sys, text);
        let parsed: { reply?: string; tag?: string } = {};
        try {
          const start = raw.indexOf("{");
          const end = raw.lastIndexOf("}");
          if (start !== -1 && end !== -1) {
            parsed = JSON.parse(raw.slice(start, end + 1));
          }
        } catch {}

        const replyText = parsed.reply || "收到";
        const tag = parsed.tag || "general";

        await this.reply(msg, replyText);
        this.conv
          .recordMsg(sid, "assistant", replyText, "telegram")
          .catch(() => {});

        // 將重點摘要儲存為低優先級記憶（可選）
        if (tag && tag !== "general") {
          this.store
            .store(`[${tag}] ${text.slice(0, 100)}`, {
              category: "chat-summary",
              importance: 0.3,
              tags: ["dialogue", tag],
            })
            .catch(() => {});
        }
      } catch {
        // AI 失敗時給予預設回應
        await this.reply(msg, "收到");
        this.conv
          .recordMsg(sid, "assistant", "收到", "telegram")
          .catch(() => {});
      }
    }
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
