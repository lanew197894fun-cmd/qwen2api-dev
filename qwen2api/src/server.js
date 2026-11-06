const express = require("express");
const bodyParser = require("body-parser");
const config = require("./config/index.js");
const cors = require("cors");
const { logger } = require("./utils/logger");
const { initSsxmodManager } = require("./utils/ssxmod-manager");
const DataPersistence = require("./utils/data-persistence");
const app = express();
const path = require("path");
const fs = require("fs");
const modelsRouter = require("./routes/models.js");
const chatRouter = require("./routes/chat.js");
const cliChatRouter = require("./routes/cli.chat.js");
const anthropicRouter = require("./routes/anthropic.js");
const verifyRouter = require("./routes/verify.js");
const accountsRouter = require("./routes/accounts.js");
const settingsRouter = require("./routes/settings.js");
const injectRouter = require("./routes/inject.js");

if (config.dataSaveMode === "file") {
  if (!fs.existsSync(path.join(__dirname, "../data/data.json"))) {
    fs.writeFileSync(
      path.join(__dirname, "../data/data.json"),
      JSON.stringify({ accounts: [] }, null, 2),
    );
  }
}

// ═══ Fix 2026-07-08: 全域 uncaughtException handler（最後防線） ═══
// 背景：chrome-fetch.js 的 stream.destroy(err) 在 Bun 中非同步發射 'error' 事件，
// 若孤立 stream 無監聽器則 crash。此 handler 確保 process 不因孤立 stream 崩潰，
// 僅記錄錯誤並優雅繼續（Chrome Fetch 會在下一個請求透過 axios 降級自動恢復）。
process.on("uncaughtException", (err) => {
  if (
    err.message?.includes("Chrome SSE evaluate") ||
    err.message?.includes("Chrome evaluate") ||
    err.message?.includes("Chrome Fetch") ||
    err.message?.includes("Chrome 無可用頁面")
  ) {
    logger.warn(
      `[CHROME] ⛔ Chrome 孤立 stream 錯誤（非致命）: ${err.message}`,
    );
    return;
  }
  logger.error(`未捕獲異常: ${err.message}`, "SERVER", "", err);
});
process.on("unhandledRejection", (err) => {
  if (
    err?.message?.includes("Chrome SSE evaluate") ||
    err?.message?.includes("Chrome evaluate") ||
    err?.message?.includes("Chrome Fetch") ||
    err?.message?.includes("Chrome 無可用頁面")
  ) {
    logger.warn(
      `[CHROME] ⛔ Chrome 孤立 Promise rejection（非致命）: ${err.message}`,
    );
    return;
  }
  logger.error(
    `未處理的 Promise rejection: ${err?.message || err}`,
    "SERVER",
    "",
    err,
  );
});

// 初始化 SSXMOD Cookie 管理器
initSsxmodManager();

// 非同步初始化 Chrome Fetch Proxy (繞過 WAF JA3 檢測)
// 初始化失敗不影響服務啟動（降級至 axios）
const { getInstance: getChromeFetch } = require("./utils/chrome-fetch");
const chromeFetch = getChromeFetch();

// ═══ 修復：qwen2api 退出時確保 Chrome 進程被殺，避免幽靈進程累積 ═══
// start.js 收到 SIGTERM 後只 call process.exit(0)，不清理 Chrome
// 導致重啟時舊 Chrome 變孤兒進程，每次重啟多 1~n 個幽靈 Chrome
// process.on("exit") 在 process.exit() 之後同步執行，此時 kill 是安全的
process.on("exit", () => {
  try {
    if (chromeFetch && chromeFetch.browser) {
      const proc = chromeFetch.browser.process();
      if (proc) proc.kill("SIGKILL");
    }
  } catch (_) {}
});
chromeFetch
  .init()
  .then(() => {
    // 啟動定期健康監控 (每 60 秒檢查一次) — 僅在 Chrome Fetch 啟用時
    if (
      process.env.DISABLE_BROWSER !== "true" &&
      process.env.CHROME_DISABLED !== "true"
    ) {
      // ═══ Fix 2026-07-08: 健康檢查只記錄，不 auto-recover ═══
      // 取消 auto-recover — 使用者關閉瀏覽器視窗 → disconnect → healthCheck false
      // → recover() 會再開新瀏覽器 → 使用者再關 → 無限循環累積孤兒 Chrome 進程.
      // 恢復應在 sendChatRequest() 中 lazy 進行（該方法已呼叫 init() 並受斷路器保護）.
      // ═══ Chrome Fetch 健康監控 ═══
      // 僅記錄狀態，不主動恢復 — chrome-fetch.js 內建階梯式永久禁用+定時恢復，
      // 外部干預會與其斷路器邏輯衝突（兩邊操作 CHROME_DISABLED 環境變數）。
      setInterval(async () => {
        try {
          const healthy = await chromeFetch.healthCheck();
          if (!healthy) {
            logger.info(
              `Chrome Fetch 不健康 (ready=${chromeFetch.ready}, browser=${!!chromeFetch.browser})，由內建斷路器管理`,
              "CHROME",
            );
          }
        } catch (e) {
          logger.error(`Chrome Fetch 健康監控異常: ${e.message}`, "CHROME");
        }
      }, 60000);
    }

    // ═══ Fix 2026-07-08: 預熱 Chrome Fetch — 不跳過 ═══
    // ready=true 只表示 Chrome 瀏覽器已啟動，但尚未建立 chat session。
    // 跳過預熱會導致第一個用戶請求觸發 createChat（耗時 15~20s），
    // 健康報告的模型測試也因無 chat session 而超時 → 🧠模型:❌。
    // 改為每次都確實執行預熱，建立好 chat session 再對外服務。
    setTimeout(async () => {
      try {
        logger.info("Chrome Fetch 預熱中...", "CHROME");
        const chatId = await chromeFetch.createChat("qwen3.6-plus-thinking");
        if (chatId) {
          logger.success(`Chrome Fetch 預熱完成 (chat: ${chatId})`, "CHROME");
        } else {
          logger.warn("Chrome Fetch 預熱：建立 chat 失敗，非致命", "CHROME");
        }
      } catch (e) {
        logger.warn(`Chrome Fetch 預熱失敗: ${e.message}（非致命）`, "CHROME");
      }
    }, 3000);
  })
  .catch((err) => {
    logger.warn(
      `Chrome Fetch Proxy 初始化失敗: ${err.message}，降級至 axios`,
      "CHROME",
    );
  });

app.use(bodyParser.json({ limit: "128mb" }));
app.use(bodyParser.urlencoded({ limit: "128mb", extended: true }));
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3456",
      "http://127.0.0.1:3456",
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      // Tailscale IP range (100.x.x.x)
      /^http:\/\/100\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      // LAN IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    ],
    maxAge: 86400,
  }),
);

// ─── Rate Limiter（滑動視窗，無依賴） ───
const RL_MAX = parseInt(process.env.API_RATE_LIMIT || "600");
const RL_WIN = parseInt(process.env.API_RATE_WINDOW || "60000");
const rlBuckets = new Map();

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + RL_WIN };
    rlBuckets.set(ip, b);
  }
  b.count++;
  if (rlBuckets.size > 10000) {
    const cutoff = Date.now();
    for (const [k, v] of rlBuckets) {
      if (cutoff > v.reset) rlBuckets.delete(k);
    }
  }
  if (b.count > RL_MAX) {
    return res.status(429).json({
      error: "Too Many Requests",
      retryAfter: Math.ceil(RL_WIN / 1000),
    });
  }
  next();
});

// API 路由
app.use(modelsRouter);
app.use(chatRouter);
app.use(cliChatRouter);
app.use(anthropicRouter);
app.use(verifyRouter);
app.use("/api", accountsRouter);
app.use("/api", settingsRouter);
app.use("/api", injectRouter);
app.use("/", require("./routes/health"));

app.use(express.static(path.join(__dirname, "../public/dist")));

// ═══ 手動注入頁面（在 SPA catch-all 之前） ═══
app.get("/inject", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/inject.html"), (err) => {
    if (err) {
      logger.error("注入頁面載入失敗", "SERVER", "", err);
      res.status(500).send("伺服器內部錯誤");
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/dist/index.html"), (err) => {
    if (err) {
      logger.error("管理頁面載入失敗", "SERVER", "", err);
      res.status(500).send("伺服器內部錯誤");
    }
  });
});

// 處理錯誤中介軟體（必須放在所有路由之後）
app.use((err, req, res, next) => {
  logger.error("伺服器內部錯誤", "SERVER", "", err);
  res.status(500).send("伺服器內部錯誤");
});

// 伺服器啟動資訊
const serverInfo = {
  address: config.listenAddress || "localhost",
  port: config.listenPort,
  outThink: config.outThink ? "開啟" : "關閉",
  searchInfoMode: config.searchInfoMode === "table" ? "表格" : "文本",
  dataSaveMode: config.dataSaveMode,
  logLevel: config.logLevel,
  enableFileLog: config.enableFileLog,
};

// 應用持久化的執行時設定（web UI > env > 預設值）
const applyPersistedSettings = async () => {
  try {
    const persisted = await new DataPersistence().loadSettings();
    if (
      persisted.chatRetryCount !== undefined &&
      persisted.chatRetryCount !== ""
    ) {
      const v = parseInt(persisted.chatRetryCount, 10);
      if (!isNaN(v) && v >= 0) config.chatRetryCount = v;
    }
    if (
      persisted.chatRetryBackoffMs !== undefined &&
      persisted.chatRetryBackoffMs !== ""
    ) {
      const v = parseInt(persisted.chatRetryBackoffMs, 10);
      if (!isNaN(v) && v >= 0) config.chatRetryBackoffMs = v;
    }
    if (persisted.apiKeys?.length > 1) {
      config.apiKeys = persisted.apiKeys;
      config.adminKey = persisted.apiKeys[0];
    }
  } catch (err) {
    logger.warn(
      "載入持久化設定失敗，使用 env/預設值",
      "CONFIG",
      "",
      err.message,
    );
  }
};

const startServer = () => {
  const listen = () => {
    // 啟動完成（無標頭）
  };

  const onError = (err) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `端口 ${config.listenPort} 已被佔用，請先停止現有服務或更換端口`,
        "SERVER",
      );
      process.exit(1);
    }
    logger.error(`伺服器啟動失敗: ${err.message}`, "SERVER");
    process.exit(1);
  };

  const svr = config.listenAddress
    ? app.listen(config.listenPort, config.listenAddress, listen)
    : app.listen(config.listenPort, listen);
  svr.on("error", onError);

  // ═══ env-guard：graceful drain ═══
  // SIGTERM/SIGINT → 停止接新連線 → 等 in-flight 自然結束或 DRAIN_TIMEOUT_MS 上限 → 退出。
  // 退出時既有的 process.on("exit") 會殺 Chrome，避免幽靈進程。
  const DRAIN_MS = Number(process.env.DRAIN_TIMEOUT_MS || 15000);
  let inflight = 0;
  const sockets = new Set();
  svr.on("connection", (s) => {
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
    logger.warn(
      `${sig} 收到：停止接新連線，排空 in-flight x${inflight}（上限 ${DRAIN_MS}ms）`,
      "SERVER",
    );
    svr.close(() => process.exit(0));
    if (typeof svr.closeIdleConnections === "function")
      svr.closeIdleConnections();
    setTimeout(() => {
      logger.warn(
        `排空逾時，強制關閉 ${sockets.size} 個殘留連線後退出`,
        "SERVER",
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
};

applyPersistedSettings().finally(startServer);
