#!/usr/bin/env bun
// start.js - qwen2api-dev unified launcher (single-terminal mode)
// Both platforms: kills old processes, launches services in same terminal
// Never exits prematurely - stays alive until Ctrl+C so errors stay visible

const { spawn, execSync } = require("child_process");
const {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} = require("fs");
const { join } = require("path");
const os = require("os");

const ROOT = __dirname;
const LOGS = join(ROOT, "logs");
const children = [];

// ─── quiet mode: suppress subprocess output prefix (logs still written) ───
const QUIET = process.argv.includes("--quiet") || process.argv.includes("-q");

// Load .env file to get API_KEY
const fs = require("fs");
const envFile = join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, "utf-8");
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.startsWith("API_KEY=")) {
      process.env.API_KEY = line.substring("API_KEY=".length).trim();
    }
    if (line.startsWith("MASTER_TS_IP=")) {
      const ip = line.substring("MASTER_TS_IP=".length).trim();
      // 自動組裝 PEERS URL（若未手動設定 PEERS）
      if (!process.env.PEERS && ip) {
        process.env.PEERS = `http://${ip}:4377`;
      }
    }
    if (line.startsWith("PEERS=")) {
      process.env.PEERS = line.substring("PEERS=".length).trim();
    }
  }
}

// ─── build management panel frontend from source ───

function buildManagementUI() {
  const uiDir = join(ROOT, "..", "Cli-Proxy-API-Management-Center");
  if (!existsSync(uiDir)) {
    log("Management UI source not found, skip local build");
    return "";
  }
  try {
    log("Building management panel frontend...");
    execSync(`${BUN} run build`, { cwd: uiDir, timeout: 60000, stdio: "pipe" });
    const outDir = join(ROOT, ".management-dist");
    const src = join(uiDir, "dist", "index.html");
    if (!existsSync(src)) {
      log("WARNING: Management UI build dist/index.html not found");
      return "";
    }
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    // Copy built single-file HTML to management.html
    fs.copyFileSync(src, join(outDir, "management.html"));
    log(`Management panel built: ${join(outDir, "management.html")}`);
    return outDir;
  } catch (e) {
    log(
      `WARNING: Management UI build failed (will use GitHub release): ${e.message}`,
    );
    return "";
  }
}

// ─── helpers ───

const log = (msg) => console.log(`[start] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUN = (() => {
  if (os.platform() === "win32") {
    for (const x of ["bun.exe", join(os.homedir(), ".bun", "bin", "bun.exe")]) {
      try {
        execSync(`where ${x} 2>nul`, { stdio: "pipe" });
        return x;
      } catch {
        /* next */
      }
    }
    return "bun.exe";
  }
  return "bun";
})();

const IS_WIN = os.platform() === "win32";
const LOG_RUN = join(LOGS, `run-${Date.now()}`); // unique per-run dir

// ─── token prompt (desktop only, interactive) ───

function isInteractive() {
  try {
    return process.stdin.isTTY;
  } catch {
    return false;
  }
}

async function promptToken() {
  const { createInterface } = require("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question("  > ", (ans) => {
      rl.close();
      r(ans.trim());
    });
  });
}

async function ensureToken() {
  // Only prompt on desktop (Windows) with an interactive terminal
  if (!IS_WIN || !isInteractive()) return;
  const { existsSync, readFileSync, writeFileSync } = require("fs");
  const envFile = join(ROOT, ".env");
  let envContent = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";

  // Check if .env already has TELEGRAM_BOT_TOKEN
  if (envContent.includes("TELEGRAM_BOT_TOKEN=")) return;

  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Telegram Bridge 設定                           ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║  TELEGRAM_BOT_TOKEN 未設定                        ║");
  console.log("║  請輸入你的 Telegram Bot Token：                   ║");
  console.log("║                                                  ║");
  console.log("║  申請方式：                                       ║");
  console.log("║  1. 開啟 Telegram，搜尋 @BotFather                 ║");
  console.log("║  2. 發送 /newbot 建立新 Bot                        ║");
  console.log("║  3. 複製取得的 HTTP API Token                      ║");
  console.log("║  4. 貼到下方輸入框按 Enter                          ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log("  Token（輸入後按 Enter，或留空跳過）：");
  const token = await promptToken();
  if (!token) {
    console.log("  ⚠️  未輸入，跳過 Telegram Bridge\n");
    return;
  }

  // Prompt for Master IP (for Laptop/Peer mode)
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   跨裝置同步設定 (可選)                            ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║  若此裝置為筆電 (Peer)，需指定主力機 IP              ║");
  console.log("║  以啟用自動推送功能。                              ║");
  console.log("║                                                  ║");
  console.log("║  取得方式：                                       ║");
  console.log("║  在主力機執行: tailscale ip -4                    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("  主力機 Tailscale IP (留空則不設定)：");
  const masterIp = await promptToken();

  let newLines = `TELEGRAM_BOT_TOKEN=${token}\n`;
  if (masterIp) {
    newLines += `MASTER_TS_IP=${masterIp}\n`;
  }

  writeFileSync(envFile, envContent + newLines, "utf-8");
  process.env.TELEGRAM_BOT_TOKEN = token;
  if (masterIp) {
    process.env.MASTER_TS_IP = masterIp;
    process.env.PEERS = `http://${masterIp}:4377`;
  }
  console.log("  ✅ 已寫入 .env\n");
}

// ─── clean old run dirs before start ───

function cleanLogs() {
  try {
    if (!existsSync(LOGS)) return;
    for (const f of readdirSync(LOGS)) {
      if (f.startsWith("run-")) {
        try {
          const dir = join(LOGS, f);
          for (const sub of readdirSync(dir)) unlinkSync(join(dir, sub));
          rmdirSync(dir);
        } catch {
          /* locked, skip */
        }
      }
    }
    log("old logs cleaned");
  } catch {
    /* best effort */
  }
}

// ─── stop PM2-managed qwen2api ───

function stopPm2Qwen() {
  try {
    execSync("pm2 stop qwen2api 2>/dev/null", { timeout: 3000 });
    execSync("pm2 delete qwen2api 2>/dev/null", { timeout: 3000 });
    log("PM2 qwen2api stopped");
  } catch {
    /* no PM2 or already stopped */
  }
}

// ─── stop systemd qwen services (auto-restart on boot) ───
// 注意：systemd Restart=always 會與 start.js 打架，需先 disable 再 stop

function stopSystemdQwen() {
  if (IS_WIN) return;
  for (const srv of ["qwen2api.service", "qwen-proxy.service"]) {
    try {
      // 先停掉 Restart=always 的自動重啟循環
      execSync(`systemctl --user disable ${srv} 2>/dev/null`, {
        timeout: 3000,
      });
      execSync(`systemctl --user stop ${srv} 2>/dev/null`, { timeout: 5000 });
      log(`systemd ${srv} stopped`);
    } catch {
      /* not a systemd service or already stopped */
    }
  }
}

// ─── kill process on port ───

function killByPort(port) {
  if (!port) return;
  try {
    if (IS_WIN) {
      const out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: "utf8",
        timeout: 3000,
      });
      for (const line of out.split("\n").filter(Boolean)) {
        const pid = line.match(/(\d+)\s*$/)?.[1];
        const addr = line.match(/:(\d+)/);
        if (pid && addr && addr[1] === String(port)) {
          try {
            execSync(`taskkill /F /PID ${pid} 2>nul`);
          } catch {
            /* already gone */
          }
        }
      }
    } else {
      execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null`, {
        timeout: 3000,
      });
    }
  } catch {
    /* no process on port */
  }
}

// ─── kill ALL qwen2api-related processes (cluster master + workers) ───
// 🛡️ 排除自身：pkill 不能匹配到當前 start.js 進程
// 跨裝置相容：使用 ROOT 變數動態建構路徑

function killAllQwen() {
  if (IS_WIN) return;
  const pid = process.pid;
  try {
    // 只殺 qwen2api/ 目錄下的進程（含尾斜線避免匹配 qwen2api-dev/start.js）
    const qwenPath = join(ROOT, "qwen2api") + "/";
    execSync(`pkill -f '${qwenPath}' 2>/dev/null; true`, { timeout: 3000 });
    // 殺掉舊版 start.js（用 pgrep 輸出 PID，排除自身 PID）
    execSync(
      `pgrep -f 'start\\.js' | grep -v ${pid} | xargs -r kill 2>/dev/null; true`,
      { timeout: 3000 },
    );
    log("All qwen2api processes killed");
  } catch {
    /* none found */
  }
}

// ─── Chrome profile 清理（orphan Chrome + SingletonLock） ───
// browser-proxy 啟動前必須清理，否則 puppeteer.launch 會因 profile 被鎖失敗
// 策略：pgrep 精確匹配 → kill -9 → 驗證死亡 → 只刪 lock files 保留 session

const CHROME_PROFILE = join(ROOT, "qwen2api", ".chrome-qwen-profile");

function killPidsByPattern(pattern) {
  try {
    const out = execSync(`pgrep -f '${pattern}' 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 3000,
    });
    const pids = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((p) => p !== process.pid);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  } catch {}
}

function killByPidFile(filePath) {
  try {
    if (!existsSync(filePath)) return;
    const pid = parseInt(fs.readFileSync(filePath, "utf-8").trim(), 10);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  } catch {}
}

function cleanupChromeProfile() {
  if (IS_WIN) return;
  try {
    // 1. 優先使用 PID file 精準殺 browser-proxy
    killByPidFile(join(ROOT, "qwen2api", ".browser-proxy.pid"));

    // 2. pgrep 掃描所有 browser-proxy 進程
    killPidsByPattern("browser-proxy\\.js");

    // 3. pgrep 掃描所有 Chrome 相關進程（含 chromium、google-chrome）
    killPidsByPattern("chrome-linux64/chrome");
    killPidsByPattern("chromium");
    killPidsByPattern("google-chrome");

    // 4. lsof 殺 port 3457（最強力）
    for (let i = 0; i < 3; i++) {
      try {
        execSync(`lsof -ti :3457 | xargs -r kill -9 2>/dev/null || true`, {
          timeout: 3000,
        });
      } catch {}
      execSync("sleep 0.3", { timeout: 2000 });
      // 確認 port 已空
      const still = execSync(`lsof -ti :3457 2>/dev/null || true`, {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!still) break;
    }

    // 5. 等待進程真正死亡
    execSync("sleep 0.5", { timeout: 2000 });

    // 6. 只刪 lock files，保留 Default/ 目錄（含 cookies/localStorage/session）
    //    SingletonLock/SingletonCookie/SingletonSocket 是 Chrome 的 profile 鎖
    //    DevToolsActivePort 是每次啟動產生的臨時檔
    try {
      for (const f of [
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
        "DevToolsActivePort",
        "BrowserMetrics-spare.pma",
      ]) {
        const fp = join(CHROME_PROFILE, f);
        try {
          execSync(`rm -f '${fp}' 2>/dev/null || true`, { timeout: 2000 });
        } catch {}
      }
      // 清理 /tmp 下的 Chrome socket 目錄（SingletonSocket 指向的地方）
      try {
        execSync(`rm -rf /tmp/org.chromium.Chromium.* 2>/dev/null || true`, {
          timeout: 2000,
        });
      } catch {}
    } catch {}

    log(
      "orphan Chrome + browser-proxy cleaned (lock files only, session preserved)",
    );
  } catch {
    /* best effort */
  }
}

// ─── health check helpers ───

async function isAlive(url, ms = 2000) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}

// ─── 模型穩定性探針（輕量級推理測試） ───

async function probeModelStability() {
  const start = Date.now();
  try {
    // 檢查模型列表而非實際聊天（上游 chat.qwen.ai 被阿里雲 WAF 阻擋）
    const res = await fetch("http://127.0.0.1:3000/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.API_KEY || "CHANGE_ME"}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - start;
    const data = await res.json();
    const ok = data?.data?.length > 0;
    return { ok, latency, score: ok ? 100 : 0 };
  } catch (e) {
    const latency = Date.now() - start;
    return { ok: false, latency, score: 0, error: e.message };
  }
}

// ─── 健康報告生成器 ───

async function generateHealthReport() {
  const services = [
    { name: "qwen2api", url: "http://127.0.0.1:3000/health" },
    // { name: "qwen2api-direct", url: "http://127.0.0.1:3001/health" },
    { name: "browser-proxy", url: "http://127.0.0.1:3457/health" },
    { name: "chat-proxy", url: "http://127.0.0.1:3456/health" },
    { name: "cliproxyapi", url: "http://127.0.0.1:8317/" },
    { name: "telegram-bridge", url: "http://127.0.0.1:4377/api/health" },
  ];

  let total = 0;
  let healthy = 0;
  const details = [];

  for (const svc of services) {
    total++;
    const start = Date.now();
    const ok = await isAlive(svc.url, 3000);
    const latency = Date.now() - start;
    if (ok) healthy++;
    details.push(`${svc.name}:${ok ? "✅" : "❌"}(${latency}ms)`);
  }

  const pct = Math.round((healthy / total) * 100);
  const icon = pct >= 90 ? "🟢" : pct >= 70 ? "🟡" : "🔴";

  // 執行模型穩定性探針
  const modelProbe = await probeModelStability();
  const modelIcon = modelProbe.ok ? "🧠" : "💀";
  const modelDetail = `${modelIcon}模型:${modelProbe.ok ? "✅" : "❌"}(${modelProbe.latency}ms)`;

  return `${icon} **健康報告**: ${pct}% | ${details.join(" ")} | ${modelDetail}`;
}

async function waitFor(url, label, timeout = 30) {
  for (let i = 0; i < timeout; i++) {
    if (await isAlive(url)) {
      log(`${label} ready`);
      return true;
    }
    await sleep(1000);
  }
  log(`WARNING: ${label} health check failed`);
  return false;
}

// ─── port availability check ───

const net = require("net");

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on("error", () => resolve(false));
    srv.on("listening", () => {
      srv.close();
      resolve(true);
    });
    srv.listen(port, "127.0.0.1");
  });
}

async function ensurePortsFree(ports, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    const busy = [];
    for (const p of ports) {
      if (!(await isPortFree(p))) busy.push(p);
    }
    if (busy.length === 0) return true;
    if (i < maxRetries - 1) {
      log(
        `Ports ${busy.join(",")} still occupied, retrying (${i + 1}/${maxRetries - 1})...`,
      );
      for (const p of busy) killByPort(p);
      await sleep(2000);
    }
  }
  return false;
}

// ─── colorize whole line by log level keyword ───
const LOG_LEVEL_COLORS = { E: "31", W: "33", I: "32", D: "90" };

function colorize(line) {
  const m = line.match(/\s\[([EWID])\]\s/);
  const c = m ? LOG_LEVEL_COLORS[m[1]] : null;
  return c ? `\x1b[${c}m${line}\x1b[0m` : line;
}

// ─── unified launch (same terminal, both platforms) ───

function launch(srv) {
  try {
    if (!existsSync(LOG_RUN)) mkdirSync(LOG_RUN, { recursive: true });

    // Try to open log files in per-run dir (never conflicts with locked old files)
    let lfd, efd;
    try {
      lfd = openSync(join(LOG_RUN, `${srv.name}.log`), "a");
      efd = openSync(join(LOG_RUN, `${srv.name}.err`), "a");
    } catch {
      log(`${srv.name} log files locked, console only`);
    }

    const proc = spawn(srv.cmd[0], srv.cmd.slice(1), {
      cwd: srv.cwd,
      env: { ...process.env, ...srv.env },
      stdio: ["pipe", "pipe", "pipe"], // P0: stdin must be pipe/inherit, not ignore (Windows/Bun exit bug)
      windowsHide: true,
    });

    const pfx = srv.name.padEnd(15);
    proc.stdout.on("data", (d) => {
      if (lfd !== undefined)
        try {
          writeSync(lfd, d); // plain text to log file
        } catch {}
      for (const l of d.toString().split("\n").filter(Boolean))
        console.log(QUIET ? l : colorize(`  [${pfx}] ${l}`));
    });
    proc.stderr.on("data", (d) => {
      if (efd !== undefined)
        try {
          writeSync(efd, d); // plain text to log file
        } catch {}
      for (const l of d.toString().split("\n").filter(Boolean))
        console.error(QUIET ? l : colorize(`  [${pfx}] ${l}`));
    });

    proc.on("exit", (code, sig) => {
      if (lfd !== undefined)
        try {
          closeSync(lfd);
        } catch {}
      if (efd !== undefined)
        try {
          closeSync(efd);
        } catch {}
      log(`${srv.name} exited (${sig ? `signal ${sig}` : `code ${code}`})`);
      const idx = children.indexOf(proc);
      if (idx >= 0) children.splice(idx, 1);
      // browser-proxy auto-restart: Chrome 崩潰時重新整理頁面
    });
    proc.on("error", (err) => log(`${srv.name} error: ${err.message}`));
    children.push(proc);
    log(`${srv.name} started (PID: ${proc.pid})`);
  } catch (err) {
    log(`Failed to launch ${srv.name}: ${err.message}`);
  }
}

// ─── cleanup ───

function cleanup() {
  log("Shutting down...");
  for (const proc of children) {
    try {
      if (IS_WIN) execSync(`taskkill /PID ${proc.pid} /T /F 2>nul`);
      else proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  log(`Stopped ${children.length} service(s)`);
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ─── main ───

async function main() {
  // Prompt for token if missing (desktop only, interactive)
  await ensureToken();

  // Build management panel frontend from source (before SRV definition)
  const managementStaticDir = buildManagementUI();

  // ─── services (defined here so env vars from ensureToken() are available) ───
  const SRV = [
    // embed-server is a stub on Windows ("Not implemented"), skip it
    ...(IS_WIN
      ? []
      : [
          {
            name: "embed-server",
            port: 11436,
            cwd: join(ROOT, "..", "scripts"),
            cmd: [BUN, "embed-server.ts"],
            env: {},
            waitUrl: null,
          },
        ]),
    ...(IS_WIN
      ? []
      : [
          {
            name: "cliproxyapi",
            port: 8317,
            cwd: join(ROOT, "..", "CLIProxyAPI"),
            cmd: [join(ROOT, "..", "CLIProxyAPI", "cliproxyapi-server")],
            env: managementStaticDir
              ? { MANAGEMENT_STATIC_PATH: managementStaticDir }
              : {},
            waitUrl: "http://127.0.0.1:8317/",
            waitTimeout: 15,
          },
        ]),
    {
      name: "qwen2api",
      port: 3000,
      cwd: join(ROOT, "qwen2api"),
      cmd: [BUN, "src/start.js", "--force"],
      env: {
        API_KEY: process.env.API_KEY || "CHANGE_ME",
        QWEN_CHAT_PROXY_URL:
          "http://127.0.0.1:3457",
      },
      waitUrl: "http://127.0.0.1:3000/health",
      waitTimeout: 30,
    },
    {
      name: "browser-proxy",
      port: 3457,
      cwd: join(ROOT, "qwen2api"),
      cmd: [BUN, "src/browser-proxy.js"],
      env: {},
      waitUrl: "http://127.0.0.1:3457/health",
      waitTimeout: 45, // Chrome launch can be slow
    },
    {
      name: "chat-proxy",
      port: 3456,
      cwd: join(ROOT, "qwen2api-plugin"),
      cmd: [BUN, "src/start-proxy.js"],
      env: {
        API_KEY: process.env.API_KEY || "CHANGE_ME",
        PROXY_LOG_LEVEL: "info",
        PROXY_ROUTE: "off",
        PROXY_FORCE_MODEL: "qwen3.6-max-preview",
      },
      waitUrl: "http://127.0.0.1:3456/health",
      waitTimeout: 15,
    },
    // telegram-bridge: 統一入口，自動偵測角色
    // 有 TELEGRAM_BOT_TOKEN → master（bot + API + push receiver + knowledge tools）
    // 無 token + Tailscale + peers → peer（fs.watch + push sender）
    {
      name: "telegram-bridge",
      port: 4377,
      cwd: join(ROOT, "telegram-memory-bridge"),
      cmd: [BUN, "src/index.ts"],
      env: {
        // 筆電模式：指定主力機 Tailscale IP 以啟用 Peer 推送
        // 格式：http://<主力機_TS_IP>:4377
        PEERS: process.env.PEERS || "",
      },
      waitUrl: "http://127.0.0.1:4377/api/health",
      waitTimeout: 20,
    },
  ];

  try {
    log(`qwen2api-dev (${os.platform()}, ${BUN})`);
    log(`Logs: ${LOG_RUN}`);

    // Kill old processes on all relevant ports
    const PORTS = [3000, 3456, 3457, 4377, 8317, 11436];
    log("Cleaning old processes...");
    stopPm2Qwen();
    stopSystemdQwen();
    killAllQwen();
    cleanupChromeProfile(); // browser-proxy Chrome + lock files
    await sleep(800);
    for (const p of PORTS) killByPort(p);
    await sleep(2000);

    // Verify all ports are actually free (retry if needed — handles fast restart)
    const allFree = await ensurePortsFree(PORTS);
    if (!allFree) {
      console.error(
        "[start] FATAL: Could not free ports after multiple retries.",
      );
      console.error(
        "[start] Close other apps using ports 3000/3456/3457/4377/8317/11436 and try again.",
      );
      log("Press Ctrl+C to exit.");
      await new Promise(() => {});
      return;
    }
    log("All ports free");

    // Clean old logs - uses per-run dir, never conflicts with locked files
    cleanLogs();

    if (IS_WIN) log("embed-server: skipped (stub on Windows)");

    // Launch services sequentially with health checks (with retry for qwen2api)
    for (const s of SRV) {
      // Build step (e.g. Go compilation) before launch
      if (s.build) {
        log(`Building ${s.name}...`);
        try {
          execSync(s.build.cmd.join(" "), {
            cwd: s.build.cwd || ROOT,
            timeout: 120000,
            stdio: "pipe",
          });
          log(`${s.name} built`);
        } catch (e) {
          log(`WARNING: ${s.name} build failed: ${e.message}`);
          continue;
        }
      }
      log(`Starting ${s.name}...`);
      launch(s);
      await sleep(1500);
      if (s.waitUrl) {
        const ok = await waitFor(s.waitUrl, s.name, s.waitTimeout);
        // Retry once for qwen2api — port may be re-occupied by auto-restart
        if (!ok && s.name === "qwen2api") {
          log("qwen2api health check failed, retrying with cleanup...");
          killAllQwen();
          killByPort(3000);
          await sleep(1000);
          launch(s);
          await waitFor(s.waitUrl, s.name, s.waitTimeout);
        }
      }
    }

    log("All services launched.");

    // ─── 啟動後健康報告 ───
    await sleep(2000); // 等待服務穩定
    const healthReport = await generateHealthReport();
    console.log("\n" + healthReport);

    log(`──────────────────────────────────────`);
    log(`  qwen2api:         http://127.0.0.1:3000`);
    // log(`  qwen2api-direct:  http://127.0.0.1:3001 (直連 API)`);
    log(`  browser-proxy:    http://127.0.0.1:3457 (WAF 繞過代理)`);
    log(
      `  登入頁面:        http://127.0.0.1:3457/login (匯入 qwen.ai cookies)`,
    );
    if (!IS_WIN) log(`  cliproxyapi:      http://127.0.0.1:8317`);
    if (!IS_WIN) log(`  管理面板:       http://127.0.0.1:8317/management.html`);
    if (!IS_WIN) log(`  embed-server:    http://127.0.0.1:11436`);
    log(`  chat-proxy:       http://127.0.0.1:3456`);
    log(`  telegram:         port 4377`);
    log(`──────────────────────────────────────`);
    log(`Press Ctrl+C to stop services.`);
  } catch (err) {
    console.error("[start] Startup error:", err.message);
  }

  // Never exit prematurely - keep terminal open so errors stay visible
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[start] Unhandled:", err.message);
});

// Stay alive even if unhandled error
process.stdin.resume();
