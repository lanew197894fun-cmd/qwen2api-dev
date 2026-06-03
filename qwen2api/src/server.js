const express = require("express");
const bodyParser = require("body-parser");
const helmet = require("helmet");
const hpp = require("hpp");
const rateLimit = require("express-rate-limit");
const config = require("./config/index.js");
const cors = require("cors");
const { logger } = require("./utils/logger");
const { initSsxmodManager } = require("./utils/ssxmod-manager");
const { gracefulShutdown } = require("./graceful-shutdown");
const { hasKey } = require("./utils/encryption");

// ─── 全域錯誤防護：防止未捕獲異常導致進程退出 ───
process.on("unhandledRejection", (reason, promise) => {
  logger.error("未處理的 Promise Rejection", "PROCESS", "", {
    reason,
    promise,
  });
  // 不要 exit，讓服務繼續運行
});

process.on("uncaughtException", (error) => {
  logger.error("未捕獲的異常", "PROCESS", "", error);
  // 記錄錯誤後繼續運行，避免中斷正在進行的對話
});

// ─── Express 4 async 錯誤自動捕獲 ───
const Layer = require("express/lib/router/layer");
const origHandle = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req, res, next) {
  const result = origHandle.call(this, req, res, next);
  if (result && typeof result.catch === "function") {
    result.catch(next);
  }
  return result;
};

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

if (config.dataSaveMode === "file") {
  const dataFile = path.join(__dirname, "../data/data.json");
  if (!fs.existsSync(dataFile)) {
    // 確保 data 目錄存在
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify({ accounts: [] }, null, 2), {
      mode: 0o600,
    });
    logger.info("預設資料檔案建立成功", "FILE", "📁");
  }
}

// ─── 加密狀態檢查 ───
if (!hasKey()) {
  logger.warn(
    "ENCRYPTION_KEY 未設定！帳戶密碼與 Token 將以明文儲存在 data/data.json",
    "SECURITY",
    "🔓",
  );
  logger.warn(
    "請在 .env 中設定 ENCRYPTION_KEY（64字元HEX或Base64編碼的32-byte金鑰）",
    "SECURITY",
  );
} else {
  logger.success(
    "資料加密已啟用，敏感欄位將使用 AES-256-GCM 加密",
    "SECURITY",
    "🔐",
  );
}

// 初始化 SSXMOD Cookie 管理器
initSsxmodManager();

// ─── 安全防護層：Helmet HTTP 標頭 ───
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    xFrameOptions: { action: "deny" },
    // xContentTypeOptions 不支援選項，直接設為 nosniff
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);
// 手動設定 X-Content-Type-Options
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// ─── 防止參數污染攻擊 ───
app.use(hpp());

// ─── 信任代理（若位於 Nginx/Cloudflare 後方） ───
app.set("trust proxy", 1);

app.use(bodyParser.json({ limit: "128mb" }));
app.use(bodyParser.urlencoded({ limit: "128mb", extended: true }));
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3456",
      "http://127.0.0.1:3456",
    ],
    maxAge: 86400,
  }),
);

// ─── 優雅關閉：拒絕新請求（關閉中時回傳 503） ───
app.use((req, res, next) => {
  if (gracefulShutdown.isShuttingDown) {
    return res.status(503).json({ error: "服務正在關閉，請稍後重試" });
  }
  next();
});

// ─── 追蹤活躍請求（串流不會被 shutdown 強制中斷） ───
app.use((req, res, next) => {
  const tracked = gracefulShutdown.track(req, res, req.path);
  if (!tracked) {
    return res.status(503).json({ error: "服務正在關閉，請稍後重試" });
  }
  next();
});

// ─── Rate Limiter（使用 express-rate-limit，支援信任代理與 IPv6） ───
const { ipKeyGenerator } = require("express-rate-limit");
const limiter = rateLimit({
  windowMs: parseInt(process.env.API_RATE_WINDOW || "60000"),
  max: parseInt(process.env.API_RATE_LIMIT || "600"),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too Many Requests",
    retryAfter: Math.ceil(
      parseInt(process.env.API_RATE_WINDOW || "60000") / 1000,
    ),
  },
  keyGenerator: (req) => {
    // 使用官方推薦的 ipKeyGenerator 處理 IPv6 正規化
    return ipKeyGenerator(req);
  },
});
app.use(limiter);

// API路由
app.use(modelsRouter);
app.use(chatRouter);
app.use(cliChatRouter);
app.use(anthropicRouter);
app.use(verifyRouter);
app.use("/api", accountsRouter);
app.use("/api", settingsRouter);
app.use("/", require("./routes/health"));
app.use("/mcp", require("./routes/mcp"));

const publicDist = path.join(__dirname, "../public/dist");
const publicRoot = path.join(__dirname, "../public");
const hasDist = fs.existsSync(publicDist);

if (hasDist) {
  app.use(express.static(publicDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(publicDist, "index.html"), (err) => {
      if (err) {
        logger.error("管理頁面載入失敗", "SERVER", "", err);
        res.status(500).send("伺服器內部錯誤");
      }
    });
  });
} else {
  app.use(express.static(publicRoot));
  app.get("/", (req, res) => {
    res.sendFile(path.join(publicRoot, "index.html"), (err) => {
      if (err) {
        logger.error("首頁載入失敗", "SERVER", "", err);
        res.status(500).send("伺服器內部錯誤");
      }
    });
  });
}

// 處理錯誤中介軟體（必須放在所有路由之後）
app.use((err, req, res, next) => {
  const errMsg = err?.message || err?.code || "伺服器內部錯誤";
  const errStack = err?.stack
    ? err.stack.split("\n").slice(0, 4).join(" | ")
    : "";
  logger.error(`伺服器內部錯誤: ${errMsg}`, "SERVER", "", {
    message: errMsg,
    stack: errStack,
    url: req?.originalUrl || req?.url,
  });
  res.status(err?.status || 500).send("伺服器內部錯誤");
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

if (config.listenAddress) {
  app.listen(config.listenPort, config.listenAddress, () => {
    logger.server("伺服器啟動成功", "SERVER", serverInfo);
    logger.info(
      "開源地址: https://github.com/lanew197894fun-cmd/qwen2api",
      "INFO",
    );
    logger.info("電報群聊: ", "INFO");
    _onServerStarted();
  });
} else {
  app.listen(config.listenPort, () => {
    logger.server("伺服器啟動成功", "SERVER", serverInfo);
    logger.info(
      "開源地址: https://github.com/lanew197894fun-cmd/qwen2api",
      "INFO",
    );
    logger.info("電報群聊: ", "INFO");
    _onServerStarted();
  });
}

// ─── 啟動後回呼 ───
function _onServerStarted() {
  // 載入先前中斷時儲存的對話
  const saved = gracefulShutdown.loadSavedSessions();
  if (saved.length > 0) {
    logger.info(`載入 ${saved.length} 個先前中斷的對話 session`, "PROCESS");
  }
}

// ─── 優雅關閉訊號處理 ───
async function _handleSignal(signal) {
  await gracefulShutdown.shutdown(signal);
  process.exit(0);
}
process.on("SIGTERM", () => _handleSignal("SIGTERM"));
process.on("SIGINT", () => _handleSignal("SIGINT"));
process.on("SIGQUIT", () => _handleSignal("SIGQUIT"));
