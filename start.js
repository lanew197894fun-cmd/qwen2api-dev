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
      break;
    }
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
  // Check if .env already has TELEGRAM_BOT_TOKEN
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    if (content.includes("TELEGRAM_BOT_TOKEN=")) return;
  }
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Telegram Bridge 設定                          ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║  TELEGRAM_BOT_TOKEN 未設定                      ║");
  console.log("║  請輸入你的 Telegram Bot Token：                ║");
  console.log("║                                                 ║");
  console.log("║  申請方式：                                     ║");
  console.log("║  1. 開啟 Telegram，搜尋 @BotFather              ║");
  console.log("║  2. 發送 /newbot 建立新 Bot                     ║");
  console.log("║  3. 複製取得的 HTTP API Token                    ║");
  console.log("║  4. 貼到下方輸入框按 Enter                      ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("  Token（輸入後按 Enter，或留空跳過）：");
  const token = await promptToken();
  if (!token) {
    console.log("  ⚠️  未輸入，跳過 Telegram Bridge\n");
    return;
  }
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, "utf-8");
  process.env.TELEGRAM_BOT_TOKEN = token;
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

function killAllQwen() {
  if (IS_WIN) return;
  const pid = process.pid;
  try {
    // 只殺 qwen2api/ 目錄下的進程（含尾斜線避免匹配 qwen2api-dev/start.js）
    execSync(
      `pkill -f '/home/reamaster/opencode-manager/projects/independent/qwen2api/' 2>/dev/null; true`,
      { timeout: 3000 },
    );
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
    const res = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.API_KEY || "CHANGE_ME"}`,
      },
      body: JSON.stringify({
        model: "qwen-plus",
        messages: [{ role: "user", content: "1+1=" }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    const data = await res.json();
    const ok = data?.choices?.length > 0;
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
    { name: "chat-proxy", url: "http://127.0.0.1:3456/health" },
    { name: "telegram-bridge", url: "http://127.0.0.1:4377/api/health" },
    { name: "waf-proxy", url: "http://127.0.0.1:3457/" },
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

  return `\n${icon} **健康報告**: ${pct}% | ${details.join(" ")} | ${modelDetail}`;
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const pfx = srv.name.padEnd(15);
    proc.stdout.on("data", (d) => {
      if (lfd !== undefined)
        try {
          writeSync(lfd, d);
        } catch {}
      for (const l of d.toString().split("\n").filter(Boolean))
        console.log(QUIET ? l : `  [${pfx}] ${l}`);
    });
    proc.stderr.on("data", (d) => {
      if (efd !== undefined)
        try {
          writeSync(efd, d);
        } catch {}
      for (const l of d.toString().split("\n").filter(Boolean))
        console.error(QUIET ? l : `  [${pfx}] ${l}`);
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
    {
      name: "waf-proxy",
      port: 3457,
      cwd: join(ROOT, "qwen2api-plugin"),
      cmd: [BUN, "src/waf-proxy.js"],
      env: {},
      waitUrl: "http://127.0.0.1:3457/",
      waitTimeout: 30,
    },
    {
      name: "qwen2api",
      port: 3000,
      cwd: join(ROOT, "qwen2api"),
      cmd: [BUN, "src/start.js", "--force"],
      env: { API_KEY: process.env.API_KEY || "CHANGE_ME" },
      waitUrl: "http://127.0.0.1:3000/health",
      waitTimeout: 30,
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
      env: {},
      waitUrl: "http://127.0.0.1:4377/api/health",
      waitTimeout: 20,
    },
    // system-watchdog 已整合至 chat-proxy 健康報告中，不再需要獨立進程
  ];

  try {
    log(`qwen2api-dev (${os.platform()}, ${BUN})`);
    log(`Logs: ${LOG_RUN}`);

    // Kill old processes on all relevant ports
    const PORTS = [3000, 3456, 3457, 4377, 11436];
    log("Cleaning old processes...");
    stopPm2Qwen();
    stopSystemdQwen();
    killAllQwen();
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
        "[start] Close other apps using ports 3000/3456/4377 and try again.",
      );
      log("Press Ctrl+C to exit.");
      await new Promise(() => {});
      return;
    }
    log("All ports free");

    // Clean old logs - uses per-run dir, never conflicts with locked files
    cleanLogs();

    if (IS_WIN) log("embed-server: skipped (stub on Windows)");

    // Auto-setup + build knowledge-wiki-plugin (telegram-bridge 依賴此插件)
    log("Setting up knowledge-wiki-plugin...");
    try {
      execSync(`${BUN} src/auto-setup/index.js`, {
        cwd: join(ROOT, "knowledge-wiki-plugin"),
        timeout: 15000,
        stdio: "pipe",
      });
      log("knowledge-wiki-plugin auto-setup done");
    } catch (e) {
      log(`WARNING: auto-setup failed: ${e.message}`);
    }
    log("Building knowledge-wiki-plugin...");
    try {
      execSync(`${BUN} run build`, {
        cwd: join(ROOT, "knowledge-wiki-plugin"),
        timeout: 30000,
        stdio: "pipe",
      });
      log("knowledge-wiki-plugin built");
    } catch (e) {
      log(`WARNING: build failed: ${e.message}`);
    }

    // Launch services sequentially with health checks (with retry for qwen2api)
    for (const s of SRV) {
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
    log(`  waf-proxy:    http://127.0.0.1:3457`);
    log(`  qwen2api:     http://127.0.0.1:3000`);
    log(`  chat-proxy:   http://127.0.0.1:3456`);
    if (!IS_WIN) log(`  embed-server: http://127.0.0.1:11436`);
    log(`  telegram:     port 4377`);
    log(`  knowledge-wiki: ${join(ROOT, "knowledge-wiki-plugin")}`);
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
