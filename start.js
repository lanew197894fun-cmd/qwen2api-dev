#!/usr/bin/env bun
/**
 * Unified cross-platform launcher for qwen2api-dev
 * Usage: bun start.js
 *
 * Linux:   spawns detached background processes
 * Windows: uses CIM + start to create visible cmd windows (escapes SSH Job Object)
 *
 * Close the visible windows on Windows to stop services.
 * Use `pkill -f qwen2api` or `kill` on Linux.
 */
import { spawn, execSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";
const ROOT = import.meta.dir;
const LOG_DIR = join(ROOT, "logs");
const QWEN_DIR = join(ROOT, "qwen2api");
const PLUGIN_DIR = join(ROOT, "qwen2api-plugin");
const API_KEY = "sk-123456";
const PORTS = [3000, 3456];

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const log = (msg) => console.log(`[start] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isAlive(url, ms = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, label, timeout = 30) {
  for (let i = 0; i < timeout; i++) {
    if (await isAlive(url)) {
      log(`${label} ready`);
      return true;
    }
    await sleep(1000);
  }
  log(`${label} NOT ready after ${timeout}s`);
  return false;
}

// ─── Linux: kill process on port ───
function linuxKillPort(port) {
  try {
    const out = execSync(`ss -tlnp "sport = :${port}" 2>/dev/null`, {
      encoding: "utf8",
      timeout: 3000,
    });
    for (const line of out.split("\n")) {
      const m = line.match(/pid=(\d+)/);
      if (m) {
        try {
          process.kill(parseInt(m[1]), "SIGTERM");
          log(`killed pid ${m[1]} on port ${port}`);
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // no process on port
  }
}

// ─── Windows: write .cmd wrappers + PS script ───
function runWindows() {
  // Normalize paths: C:/foo/bar → C:\foo\bar (Windows convention, safe in PS "" strings)
  function winPath(p) {
    // On Windows, import.meta.dir uses \, but if we see /, convert
    return p.replace(/\//g, "\\");
  }
  const qwenDir = winPath(QWEN_DIR);
  const pluginDir = winPath(PLUGIN_DIR);
  const logDir = winPath(LOG_DIR);

  // ── Write wrapper .ps1 files (PS5/PS7 compatible, avoids batch encoding bugs) ──
  const qwenPsFile = logDir + "\\start-qwen2api.ps1";
  const proxyPsFile = logDir + "\\start-chat-proxy.ps1";
  const bunPath = "$env:USERPROFILE\\.bun\\bin\\bun.exe";
  const qwenPsContent = [
    "#Requires -Version 5.0",
    '$ErrorActionPreference = "Continue"',
    '$env:API_KEY = "' + API_KEY + '"',
    '& "' + bunPath + '" "' + qwenDir + '\\src\\start.js" --force',
    "",
  ].join("\r\n");
  const proxyPsContent = [
    "#Requires -Version 5.0",
    '$ErrorActionPreference = "Continue"',
    '$env:API_KEY = "' + API_KEY + '"',
    '$env:PROXY_LOG_LEVEL = "info"',
    '& "' + bunPath + '" "' + pluginDir + '\\src\\start-proxy.js"',
    "",
  ].join("\r\n");
  writeFileSync(qwenPsFile, qwenPsContent, "utf-8");
  writeFileSync(proxyPsFile, proxyPsContent, "utf-8");

  // ── Write CIM launcher script ──
  // Uses CIM (Win32_Process Create) to escape SSH Job Object,
  // then `start` with powershell -NoExit to create a visible window.
  //
  // PS quoting: inside "..." use "" to produce one literal "
  //   full: "start ""title"" powershell -NoExit -ExecutionPolicy Bypass -File ""path\file.ps1"""
  //   → CIM receives: start "title" powershell -NoExit -ExecutionPolicy Bypass -File "path\file.ps1"

  const lines = [];
  lines.push("#Requires -Version 5.0");
  lines.push(
    "# qwen2api-dev Windows launcher via CIM (escapes SSH Job Object)",
  );
  lines.push("");

  // Kill old
  lines.push("# ── Kill old processes ──");
  lines.push('Write-Host "[start] Cleaning up ports 3000, 3456..."');
  lines.push(
    "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object {",
  );
  lines.push(
    "  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue",
  );
  lines.push(
    '  Write-Host "[start] killed PID $($_.OwningProcess) on port 3000"',
  );
  lines.push("}");
  lines.push(
    "Get-NetTCPConnection -LocalPort 3456 -ErrorAction SilentlyContinue | ForEach-Object {",
  );
  lines.push(
    "  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue",
  );
  lines.push(
    '  Write-Host "[start] killed PID $($_.OwningProcess) on port 3456"',
  );
  lines.push("}");
  lines.push("Start-Sleep -Seconds 1");
  lines.push("");

  // Start qwen2api
  lines.push("# ── Start qwen2api (port 3000) ──");
  lines.push('Write-Host "[start] Launching qwen2api..."');
  // "" inside PS "..." → one "
  // CommandLine = "start ""title"" powershell -NoExit -File ""path\file.ps1""",
  lines.push(
    "$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{",
    '  CommandLine = "start ""qwen2api"" powershell -NoExit -ExecutionPolicy Bypass -File ""' +
      qwenPsFile +
      '"""',
    "}",
  );
  lines.push("Start-Sleep -Seconds 1");
  lines.push("");

  // Start chat proxy
  lines.push("# ── Start chat proxy (port 3456) ──");
  lines.push('Write-Host "[start] Launching chat-proxy..."');
  lines.push(
    "$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{",
    '  CommandLine = "start ""chat-proxy"" powershell -NoExit -ExecutionPolicy Bypass -File ""' +
      proxyPsFile +
      '"""',
    "}",
  );
  lines.push("");

  lines.push(
    'Write-Host "[start] Both services launched in separate visible windows."',
  );
  lines.push('Write-Host "[start] Close the windows to stop the services."');
  lines.push('Write-Host ""');
  lines.push('Write-Host "Press Enter to close this window..."');
  lines.push("Read-Host");

  const psContent = lines.join("\n");
  const psFile = logDir + "\\start-services.ps1";
  writeFileSync(psFile, psContent, "utf-8");

  log("Windows mode: launching via CIM...");
  try {
    execSync('powershell -ExecutionPolicy Bypass -File "' + psFile + '"', {
      stdio: "inherit",
      timeout: 30000,
      shell: true,
    });
  } catch (e) {
    if (e.status === undefined) log("PowerShell launch failed, check logs");
  }
}

// ─── Linux: spawn processes with visible logs ───
async function runLinux() {
  log("Linux mode: starting services...");

  // Kill old processes
  for (const port of PORTS) linuxKillPort(port);
  await sleep(1500);

  // Log files for live tailing
  const qwenLog = join(LOG_DIR, "qwen2api.log");
  const proxyLog = join(LOG_DIR, "chat-proxy.log");

  // qwen2api
  log("Starting qwen2api (port 3000)...");
  const qwenOut = createWriteStream(qwenLog);
  const qwen = spawn("bun", ["src/start.js", "--force"], {
    cwd: QWEN_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_RESTART: "true", API_KEY },
    detached: true,
  });
  qwen.stdout.pipe(qwenOut);
  qwen.stderr.pipe(qwenOut);
  qwen.unref();

  const qwenOk = await waitFor("http://127.0.0.1:3000/health", "qwen2api");
  if (!qwenOk) {
    log("WARNING: qwen2api health check failed, continuing anyway");
  }

  // chat-proxy
  log("Starting chat-proxy (port 3456)...");
  const proxyOut = createWriteStream(proxyLog);
  const proxy = spawn("bun", ["src/start-proxy.js"], {
    cwd: PLUGIN_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, API_KEY, PROXY_LOG_LEVEL: "info" },
    detached: true,
  });
  proxy.stdout.pipe(proxyOut);
  proxy.stderr.pipe(proxyOut);
  proxy.unref();

  await sleep(2000);

  // Print status and tail logs to keep terminal visible
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("  Both services are running.");
  console.log("  Logs are being shown below in real-time.");
  console.log("  Press Ctrl+C to stop watching");
  console.log("  (services will keep running in background)");
  console.log("═══════════════════════════════════════════");
  console.log("");

  // Tail log files - keeps terminal open showing live output
  try {
    const tail = spawn("tail", ["-f", qwenLog, proxyLog], {
      stdio: "inherit",
    });
    // Wait for tail to finish (Ctrl+C)
    await new Promise((resolve) => {
      tail.on("exit", resolve);
    });
  } catch {
    // tail not available, just keep alive with periodic status
    log("tail not available, showing periodic status (Ctrl+C to stop)...");
    while (true) {
      await sleep(30000);
      log("Services still running. Press Ctrl+C to stop monitoring.");
    }
  }
}

// ─── Main ───
async function main() {
  log(`Platform: ${process.platform}`);
  if (IS_WIN) {
    runWindows();
  } else {
    await runLinux();
  }
}

main().catch((e) => {
  console.error("[start] Fatal:", e);
  process.exit(1);
});
