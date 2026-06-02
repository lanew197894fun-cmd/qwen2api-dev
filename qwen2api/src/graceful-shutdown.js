/**
 * 優雅關閉管理器 — 追蹤活躍請求，關閉時排空後再退出
 *
 * 解決：修改程式碼 → 重啟服務 → 強制中斷進行中的串流 → 模型斷線
 */
const fs = require("fs");
const path = require("path");
const { logger } = require("./utils/logger");

const SESSION_FILE = path.join(__dirname, "../data/active-sessions.json");
const DRAIN_TIMEOUT = parseInt(process.env.DRAIN_TIMEOUT || "120000", 10); // 最長等待 120 秒（可透過環境變數覆蓋）
const POLL_INTERVAL = 300;

class GracefulShutdown {
  constructor() {
    /** @type {Map<symbol, { req: object, res: object, startedAt: number, label: string }>} */
    this.active = new Map();
    this.isShuttingDown = false;
    this._onDrainComplete = null;
  }

  /** 註冊一個活躍請求 */
  track(req, res, label = "unknown") {
    if (this.isShuttingDown) return false;

    const id = Symbol("req");
    const entry = { req, res, startedAt: Date.now(), label };

    this.active.set(id, entry);

    const cleanup = () => {
      this.active.delete(id);
    };
    res.on("finish", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    return true;
  }

  /** 取得活躍請求數量 */
  get activeCount() {
    return this.active.size;
  }

  /** 開始優雅關閉 */
  async shutdown(signal) {
    // P1-2: 確保 _saveSessions 為 async
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.warn(`收到 ${signal} 訊號，開始優雅關閉程序...`, "PROCESS", "🛑");
    logger.info(`目前活躍請求數: ${this.active.size}`, "PROCESS");

    if (this.active.size > 0) {
      logger.info(
        `等待 ${this.active.size} 個活躍請求完成（最長 ${DRAIN_TIMEOUT / 1000} 秒）...`,
        "PROCESS",
      );

      const deadline = Date.now() + DRAIN_TIMEOUT;
      while (this.active.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      if (this.active.size > 0) {
        logger.warn(
          `${this.active.size} 個請求逾時未完成，強制關閉`,
          "PROCESS",
        );
        for (const [id, entry] of this.active) {
          try {
            if (!entry.res.writableEnded) {
              const contentType = entry.res.getHeader("Content-Type");
              // SSE 串流需發送協議格式錯誤訊息，避免破壞客戶端解析
              if (contentType && contentType.includes("text/event-stream")) {
                entry.res.write(
                  `data: ${JSON.stringify({ error: "service_shutdown", message: "服務正在關閉，請稍後重試" })}\n\n`,
                );
                entry.res.end();
              } else {
                entry.res
                  .status(503)
                  .json({ error: "服務正在關閉，請稍後重試" })
                  .catch(() => {});
              }
            }
          } catch (_) {
            /* ignore */
          }
          this.active.delete(id);
        }
      } else {
        logger.success("所有活躍請求已完成", "PROCESS");
      }
    }

    await this._saveSessions();
    logger.info("優雅關閉完成", "PROCESS", "✅");
  }

  /** 儲存活躍對話 session */
  async _saveSessions() {
    try {
      const dir = path.dirname(SESSION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // 從活躍請求中嘗試提取 session 資訊
      const sessions = [];
      for (const [, entry] of this.active) {
        const body = entry.req.body || {};
        if (body.messages && Array.isArray(body.messages)) {
          sessions.push({
            savedAt: Date.now(),
            // 只保留最近 20 則訊息
            messages: body.messages.slice(-20),
            model: body.model,
            chat_id: body.chat_id || null,
          });
        }
      }

      await fs.promises.writeFile(
        SESSION_FILE,
        JSON.stringify({ sessions, savedAt: Date.now() }, null, 2),
        "utf-8",
      );
      logger.info(
        `已儲存 ${sessions.length} 個活躍對話至 ${SESSION_FILE}`,
        "PROCESS",
      );
    } catch (e) {
      logger.error("儲存活躍對話 session 失敗", "PROCESS", "", e);
    }
  }

  /** 載入先前儲存的 session */
  loadSavedSessions() {
    try {
      if (!fs.existsSync(SESSION_FILE)) return [];
      const raw = fs.readFileSync(SESSION_FILE, "utf-8");
      const data = JSON.parse(raw);

      // 超過 10 分鐘的 session 視為過期
      const cutoff = Date.now() - 10 * 60 * 1000;
      if (data.savedAt < cutoff) {
        fs.unlinkSync(SESSION_FILE);
        return [];
      }

      fs.unlinkSync(SESSION_FILE); // 讀取後清除
      return data.sessions || [];
    } catch (e) {
      try {
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      } catch (_) {}
      return [];
    }
  }
}

// 單例
const gracefulShutdown = new GracefulShutdown();

module.exports = { gracefulShutdown, GracefulShutdown };
