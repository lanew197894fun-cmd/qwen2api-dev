const cluster = require("cluster");
const os = require("os");
const net = require("net");
const { execSync } = require("child_process");
const { logger } = require("./utils/logger");

// 載入環境變數
require("dotenv").config();

// 解析 CLI 參數
const args = process.argv.slice(2);
const FORCE_RESTART =
  process.env.FORCE_RESTART === "true" ||
  args.includes("--force") ||
  args.includes("-f");
const QUIET = args.includes("--quiet") || args.includes("-q");

// 獲取CPU核心數
const cpuCores = os.cpus().length;

// 獲取環境變數配置
const PM2_INSTANCES = process.env.PM2_INSTANCES || "1";
const SERVICE_PORT = process.env.SERVICE_PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "production";

// ── 埠號可用性檢查 ──
async function checkPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close();
      resolve(true);
    });
    srv.listen(port, host);
  });
}

// ── 取得佔用埠號的 PID 列表 ──
function findPidsOnPort(port) {
  try {
    const platform = os.platform();
    let out = "";

    if (platform === "linux") {
      out = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null`, {
        encoding: "utf8",
        timeout: 3000,
      });
    } else if (platform === "darwin") {
      // macOS 使用 lsof
      out = execSync(`lsof -i :${port} -sTCP:LISTEN 2>/dev/null`, {
        encoding: "utf8",
        timeout: 3000,
      });
    } else if (platform === "win32") {
      out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: "utf8",
        timeout: 3000,
      });
    } else {
      logger.warn(`不支援的平台: ${platform}，跳過 PID 檢測`, "PORT");
      return [];
    }

    const pids = new Set();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      if (platform === "win32") {
        const parts = line.trim().split(/\s+/);
        const last = parts[parts.length - 1];
        if (/^\d+$/.test(last)) pids.add(parseInt(last));
      } else {
        const m = line.match(/pid=(\d+)/) || line.match(/\b(\d{2,7})\b/);
        if (m) pids.add(parseInt(m[1]));
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

// ── 判斷 PID 是否為 Qwen2API 程式 ──
function isQwenProcess(pid) {
  try {
    const platform = os.platform();
    let cmdline = "";

    if (platform === "linux") {
      cmdline = require("fs").readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } else if (platform === "darwin") {
      // macOS 使用 ps 命令
      const out = execSync(`ps -p ${pid} -o command= 2>/dev/null`, {
        encoding: "utf8",
        timeout: 3000,
      });
      cmdline = out.trim();
    } else {
      return false;
    }

    return (
      cmdline.includes("qwen2api") ||
      cmdline.includes("server.js") ||
      cmdline.includes("start.js")
    );
  } catch {
    return false;
  }
}

// ── 嘗試釋放埠號 ──
async function freePort(port, pids) {
  // 先 SIGTERM 優雅關閉
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      logger.warn(`已發送 SIGTERM 給 PID ${pid}`, "PORT");
    } catch {
      /* 程式可能已消失 */
    }
  }
  // 等待埠號釋放（最長 5 秒）
  for (let i = 0; i < 10; i++) {
    if (await checkPort(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  // 若未釋放，強制 SIGKILL
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      logger.warn(`已強制終止 PID ${pid}`, "PORT");
    } catch {
      /* 忽略 */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  return checkPort(port);
}

// ── 主啟動流程 ──
async function main() {
  const portFree = await checkPort(parseInt(SERVICE_PORT));

  if (!portFree) {
    const pids = findPidsOnPort(parseInt(SERVICE_PORT));
    const qwenPids = pids.filter(isQwenProcess);

    if (qwenPids.length > 0) {
      logger.warn(
        `埠 ${SERVICE_PORT} 已被 Qwen2API 佔用 (PID: ${qwenPids.join(", ")})`,
        "PORT",
      );
      if (FORCE_RESTART) {
        logger.info("FORCE_RESTART 模式：正在終止舊程式...", "PORT");
        const ok = await freePort(parseInt(SERVICE_PORT), qwenPids);
        if (!ok) {
          logger.error(`無法釋放埠 ${SERVICE_PORT}，請手動檢查`, "PORT");
          process.exit(1);
        }
        logger.success("埠號已釋放，繼續啟動", "PORT");
      } else {
        logger.info("已存在執行中的 Qwen2API 實例，跳過啟動", "PORT");
        logger.info(
          "提示：若需強制重啟，請使用 FORCE_RESTART=true 或 --force 參數",
          "PORT",
        );
        process.exit(0);
      }
    } else {
      const allPids = pids.join(", ") || "未知程式";
      logger.error(
        `埠 ${SERVICE_PORT} 已被其他程式佔用 (PID: ${allPids})，無法啟動`,
        "PORT",
      );
      if (FORCE_RESTART) {
        logger.warn(
          "FORCE_RESTART 模式：將終止所有佔用程式（非 Qwen2API）",
          "PORT",
        );
        const ok = await freePort(parseInt(SERVICE_PORT), pids);
        if (!ok) {
          logger.error(`仍無法釋放埠 ${SERVICE_PORT}`, "PORT");
          process.exit(1);
        }
        logger.success("埠號已釋放，繼續啟動", "PORT");
      } else {
        process.exit(1);
      }
    }
  }

  // === 以下為原啟動邏輯 ===
  // 解析程式數
  let instances;
  if (PM2_INSTANCES === "max") {
    instances = cpuCores;
  } else if (!isNaN(PM2_INSTANCES)) {
    instances = parseInt(PM2_INSTANCES);
  } else {
    instances = 1;
  }

  // 限制程式數不能超過CPU核心數
  if (instances > cpuCores) {
    logger.warn(
      `配置的程式數(${instances})超過CPU核心數(${cpuCores})，自動調整為${cpuCores}`,
      "AUTO",
    );
    instances = cpuCores;
  }

  logger.info("🚀 Qwen2API 智慧啟動", "AUTO");
  logger.info(`CPU核心數: ${cpuCores}`, "AUTO");
  logger.info(`配置的程式數: ${PM2_INSTANCES}`, "AUTO");
  logger.info(`實際啟動程式數: ${instances}`, "AUTO");
  logger.info(`服務埠: ${SERVICE_PORT}`, "AUTO");

  // 智慧判斷啟動方式
  if (instances === 1) {
    logger.info("📦 使用單程式模式啟動", "AUTO");
    require("./server.js");
  } else {
    // 檢查是否通過PM2啟動
    if (process.env.PM2_USAGE || process.env.pm_id !== undefined) {
      logger.info(
        `PM2程式啟動 - 程式ID: ${process.pid}, 工作程式ID: ${process.env.pm_id || "unknown"}`,
        "PM2",
      );
      require("./server.js");
    } else if (cluster.isMaster) {
      logger.info(`🔥 使用Node.js叢集模式啟動 (${instances}個程式)`, "AUTO");

      logger.info(`啟動主程式 - PID: ${process.pid}`, "CLUSTER");
      logger.info(`執行環境: ${NODE_ENV}`, "CLUSTER");

      // 建立工作程式
      for (let i = 0; i < instances; i++) {
        const worker = cluster.fork();
        logger.info(
          `啟動工作程式 ${i + 1}/${instances} - PID: ${worker.process.pid}`,
          "CLUSTER",
        );
      }

      // 監聽工作程式退出
      const workerRestartCooldown = new Map(); // workerId → lastRestartTime
      const RESTART_COOLDOWN_MS = 30_000; // 30 秒冷卻

      cluster.on("exit", (worker, code, signal) => {
        logger.error(
          `工作程式 ${worker.process.pid} 已退出 - 退出碼: ${code}, 訊號: ${signal}`,
          "CLUSTER",
        );

        // 自動重啟工作程式（加入冷卻機制防止風暴）
        if (!worker.exitedAfterDisconnect) {
          const now = Date.now();
          const lastRestart = workerRestartCooldown.get(worker.id) || 0;

          if (now - lastRestart < RESTART_COOLDOWN_MS) {
            logger.warn(
              `工作程式重啟冷卻中，跳過 (${RESTART_COOLDOWN_MS - (now - lastRestart)}ms 剩餘)`,
              "CLUSTER",
            );
            return;
          }

          workerRestartCooldown.set(worker.id, now);
          logger.info("正在重啟工作程式...", "CLUSTER");
          const newWorker = cluster.fork();
          logger.info(
            `新工作程式已啟動 - PID: ${newWorker.process.pid}`,
            "CLUSTER",
          );
        }
      });

      // 監聽工作程式線上
      cluster.on("online", (worker) => {
        logger.info(`工作程式 ${worker.process.pid} 已上線`, "CLUSTER");
      });

      // 監聽工作程式斷開連線
      cluster.on("disconnect", (worker) => {
        logger.warn(`工作程式 ${worker.process.pid} 已斷開連線`, "CLUSTER");
      });

      // 優雅關閉處理
      process.on("SIGTERM", () => {
        logger.info("收到SIGTERM訊號，正在優雅關閉...", "CLUSTER");
        cluster.disconnect(() => {
          process.exit(0);
        });
      });

      process.on("SIGINT", () => {
        logger.info("收到SIGINT訊號，正在優雅關閉...", "CLUSTER");
        cluster.disconnect(() => {
          process.exit(0);
        });
      });
    } else {
      // 工作程式邏輯
      logger.info(`工作程式啟動 - PID: ${process.pid}`, "WORKER");
      require("./server.js");

      // 工作程式優雅關閉處理
      process.on("SIGTERM", () => {
        logger.info(
          `工作程式 ${process.pid} 收到SIGTERM訊號，正在關閉...`,
          "WORKER",
        );
        process.exit(0);
      });

      process.on("SIGINT", () => {
        logger.info(
          `工作程式 ${process.pid} 收到SIGINT訊號，正在關閉...`,
          "WORKER",
        );
        process.exit(0);
      });
    }
  }
}

main();
