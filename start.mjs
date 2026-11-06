#!/usr/bin/env bun
// start.mjs - qwen2api-dev 統一啟動器
// 遵循 ARCHITECTURE.md 第 111-148 行規範：8 步啟動流程
// 不變邊界：非同步啟動、PID 檔追蹤自身行程、不無差別殺埠
//
// 🚫 LOCKED: 啟動界面鎖定
// 以下輸出區塊為「啟動界面」，AI 模型進行任何修復時不得修改其格式/內容/順序：
//   §1 slog() 格式  → 詳見下方 slog() 定義
//   §2 開場橫幅     → main() 開頭的 [INFO] 訊息 (L598-599)
//   §3 服務啟動日誌  → launch() 的「已啟動」訊息 (L385)
//   §4 健康報告格式  → genReport() 的單行摘要 (L580)
//   §5 硬體報告格式  → hwReport() 的具體欄位與排序 (L516-525)
//   §6 服務摘要      → 各服務 URL 列表 (L701-704)
//   §7 功能特徵列表  → 推理模式/模型路由/學習/進化引擎 (L714-719)
//   §8 知識工具狀態  → wiki/knowledge/lesson 狀態行 (L722-729)
//   §9 運行中心跳    → setInterval 的運行中狀態 (L743)
// 詳見 AGENTS.md → 啟動界面鎖定

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  appendFileSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import net from "node:net";

// ─── 跨裝置路徑：從集中管理模組匯入（單一事實來源） ───
import {
  OPENCODE_DIR as _OC_DIR,
  LESSON_DIR as _LS_DIR,
  WIKI_DIR as _WK_DIR,
  KNOWLEDGE_DIR as _KW_DIR,
  MEMORY_DIR as _MEM_DIR,
} from "./config/paths.js";

const IS_WIN = os.platform() === "win32";
const ROOT = (() => {
  const p = new URL(".", import.meta.url).pathname;
  // Windows: new URL 回傳 /C:/path/...，需移除前導 /
  return IS_WIN && p.startsWith("/") ? p.slice(1) : p;
})();
const LOGS = join(ROOT, "logs");
const STARTUP_LOG = join(LOGS, "startup.log");
const PID_FILE = join(os.tmpdir(), "qwen2api-dev.pid");
const SERVICE_PIDS = join(os.tmpdir(), "qwen2api-svc-pids.json"); // 只殺自己啟動的行程
const children = [];

process.stdin.resume();

// ─── 日誌 ─── 🚫 LOCKED §1: slog() 格式 — 時間戳 + [start] prefix 不得修改
const slog = (msg) => {
  const line = `[${new Date().toISOString()}] [start] ${msg}`;
  console.log(`[start] ${msg}`);
  try {
    mkdirSync(LOGS, { recursive: true });
    appendFileSync(STARTUP_LOG, line + "\n");
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUN = process.execPath || "bun";

// 載入 .env
(function loadEnv() {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.substring(0, eq).trim();
    const v = t
      .substring(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
})();

// ─── Step 1: 前置檢查 ───
function preflight() {
  const checks = [
    { name: "bun", ok: !!BUN },
    {
      name: "qwen2api/node_modules",
      ok: existsSync(join(ROOT, "qwen2api", "node_modules")),
    },
    {
      name: "qwen2api-plugin/node_modules",
      ok: existsSync(join(ROOT, "qwen2api-plugin", "node_modules")),
    },
    { name: ".env", ok: existsSync(join(ROOT, ".env")) },
  ];
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    for (const c of failed) slog(`⚠️  前置檢查失敗: ${c.name}`);
    return false;
  }
  slog(`✅  前置檢查通過`);
  return true;
}

// ─── PID 檔案追蹤 — 只殺自己啟動的行程 ───
function loadSvcPids() {
  try {
    if (existsSync(SERVICE_PIDS))
      return JSON.parse(readFileSync(SERVICE_PIDS, "utf-8"));
  } catch {}
  return {};
}
function saveSvcPids(map) {
  writeFileSync(SERVICE_PIDS, JSON.stringify(map), "utf-8");
}
function regPid(name, pid) {
  const map = loadSvcPids();
  map[name] = pid;
  saveSvcPids(map);
}
function unregPid(name) {
  const map = loadSvcPids();
  delete map[name];
  saveSvcPids(map);
}
function killSvcPids() {
  const map = loadSvcPids();
  for (const [name, pid] of Object.entries(map)) {
    if (!pid) continue;
    try {
      process.kill(pid, 0); // 檢查是否存在
      process.kill(pid, "SIGTERM");
      slog(`關閉 ${name} (PID ${pid})`);
    } catch {}
  }
  saveSvcPids({});
}

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

function isPortOpen(port, ms = 300) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(ms);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.connect(port, "127.0.0.1");
  });
}

async function checkSvc(url, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const body = await r.json();
    if (url.includes("3000")) {
      const s = body?.status;
      return { ok: s === "healthy", detail: s || "unknown" };
    }
    if (url.includes("3456")) {
      const u = body?.upstream;
      return {
        ok: body?.proxy === "running" && u !== "unreachable",
        detail: u || "unknown",
      };
    }
    if (url.includes("4377")) {
      const s = body?.status;
      return { ok: s === "ok", detail: s || "unknown" };
    }
    return { ok: true, detail: "ok" };
  } catch (e) {
    return { ok: false, detail: e?.code || e?.message || "timeout" };
  }
}

async function waitFor(url, label, timeout = 30) {
  for (let i = 0; i < timeout; i++) {
    const r = await checkSvc(url, 2000);
    if (r.ok) {
      console.log();
      slog(`${label} 就緒`);
      return true;
    }
    await sleep(1000);
  }
  slog(`WARNING: ${label} 健康檢查超時`);
  return false;
}

// 清理舊 start.mjs（讀 PID 檔）
function killOldParent() {
  try {
    if (existsSync(PID_FILE)) {
      const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          process.kill(oldPid, "SIGTERM");
          slog(`殺了舊行程 PID ${oldPid}`);
        } catch {}
      }
    }
  } catch {}
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

// 檢查行程是否屬於本專案（比對 cwd）
function isOurProcess(pid) {
  try {
    const cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return cwd.startsWith(ROOT);
  } catch {
    return false;
  }
}

// 只殺屬於本專案的孤兒行程（避開系統行程）
function killOurByPort(port) {
  if (!port) return 0;
  let killed = 0;
  try {
    let raw;
    if (IS_WIN) {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        timeout: 3000,
      });
      for (const line of out.split("\n").filter(Boolean)) {
        const m = line.match(/(\d+)\s*$/);
        if (m) {
          try {
            execSync(`taskkill /F /PID ${m[1]} 2>nul`, { timeout: 2000 });
            killed++;
          } catch {}
        }
      }
    } else {
      raw = execSync(`lsof -ti :${port} 2>/dev/null`, {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!raw) {
        const fuser = execSync(`fuser ${port}/tcp 2>/dev/null`, {
          encoding: "utf8",
          timeout: 3000,
        }).trim();
        raw = [...fuser.matchAll(/\d+/g)].join(" ");
      }
      if (raw) {
        const allPids = raw
          .replace(/\n/g, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const ourPids = allPids.filter(isOurProcess);
        if (ourPids.length > 0) {
          execSync(`kill -9 ${ourPids.join(" ")} 2>/dev/null`, {
            timeout: 3000,
          });
          killed = ourPids.length;
        }
      }
    }
  } catch {}
  return killed;
}

// 確認埠已釋放（輪詢 5 秒，只殺本專案行程）
async function waitPortFree(port, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (IS_WIN) {
        const out = execSync(`netstat -ano | findstr :${port}`, {
          encoding: "utf8",
          timeout: 2000,
        });
        const pids = out
          .split("\n")
          .map((l) => l.match(/(\d+)\s*$/)?.[1])
          .filter(Boolean);
        if (!pids.length) return true;
        for (const pid of pids) {
          execSync(`taskkill /F /PID ${pid} 2>nul`, { timeout: 2000 });
        }
      } else {
        const pids = execSync(`lsof -ti :${port} 2>/dev/null`, {
          encoding: "utf8",
          timeout: 2000,
        }).trim();
        if (!pids) return true;
        const ourPids = pids
          .replace(/\n/g, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .filter(isOurProcess);
        if (ourPids.length > 0) {
          execSync(`kill -9 ${ourPids.join(" ")} 2>/dev/null`, {
            timeout: 2000,
          });
        } else {
          // 埠被系統行程佔用，跳過
          return false;
        }
      }
    } catch (e) {
      // lsof/taskkill 退出碼 1 → 埠已釋放
      if (e?.status === 1 || e?.code === 1) return true;
    }
    await sleep(300);
  }
  return false;
}

// 掃描 qwen2api 專屬 Chrome 孤兒行程（只殺明確隸屬的 headless chrome）
function killChromeOrphans() {
  if (IS_WIN) return;
  try {
    const out = execSync(
      `ps aux | grep "chrome.*chrome-qwen-profile" | grep -v grep | awk '{print $2}' 2>/dev/null`,
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    if (!out) return;
    for (const pid of out.split("\n").filter(Boolean)) {
      const n = parseInt(pid);
      if (!n) continue;
      // 二次確認：檢查 cmdline 是否包含 qwen2api 相關字樣
      try {
        const cmd = execSync(`cat /proc/${n}/cmdline 2>/dev/null`, {
          encoding: "utf8",
          timeout: 1000,
        }).trim();
        if (!cmd.includes("qwen") && !cmd.includes("chrome-qwen")) continue;
      } catch {
        continue;
      }
      try {
        process.kill(n, "SIGTERM"); // 先 SIGTERM 給機會清理
        setTimeout(() => {
          try {
            process.kill(n, "SIGKILL");
          } catch {}
        }, 3000);
        slog(`關閉 Chrome 孤兒 PID ${n}`);
      } catch {}
    }
  } catch {}
}

// ─── 服務啟動 ───
// 2026-11-06: 連續重啟次數（防壞碼無限快速重啟），服務穩定 60s 後歸零。
const _restartStreak = new Map();
function launch(srv) {
  mkdirSync(LOGS, { recursive: true });
  const runDir = join(LOGS, `run-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  let lfd, efd;
  try {
    lfd = openSync(join(runDir, `${srv.name}.log`), "a");
    efd = openSync(join(runDir, `${srv.name}.err`), "a");
  } catch {}

  const proc = spawn(srv.cmd[0], srv.cmd.slice(1), {
    cwd: srv.cwd,
    // ═══ Fix 2026-10-18: 子行程色彩能力與啟動方式一致 ═══
    //
    // 【症狀】`./start.sh` 與 `bun dev` 顯示樣式不同（一方有色、一方無色）
    // 【根因】stdio 用 pipe → 子行程的 process.stdout.isTTY === false
    //       → color.js 的 _supportsColor() 直接 return false → 無色純文字
    // 【解法】把父行程的色彩能力明確傳給子行程，讓兩種啟動方式一致
    env: {
      ...process.env,
      ...srv.env,
      // 父行程有 TTY 時強制子行程啟用色彩；NO_COLOR 優先
      ...(process.stdout.isTTY && process.env.NO_COLOR === undefined
        ? { FORCE_COLOR: "1" }
        : {}),
      // 傳遞 COLORTERM，確保 24-bit TrueColor 判斷生效
      ...(process.stdout.isTTY && process.env.COLORTERM
        ? { COLORTERM: process.env.COLORTERM }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pfx = ``;
  proc.stdout.on("data", (d) => {
    if (lfd !== undefined)
      try {
        writeSync(lfd, d);
      } catch {}
    for (const l of d.toString().split("\n").filter(Boolean))
      console.log(`${pfx}${l}`);
  });
  proc.stderr.on("data", (d) => {
    if (efd !== undefined)
      try {
        writeSync(efd, d);
      } catch {}
    for (const l of d.toString().split("\n").filter(Boolean))
      console.log(`${pfx}${l}`); // 用 stdout 避免 stderr 污染對話框
  });
  regPid(srv.name, proc.pid);
  proc.on("exit", (code, sig) => {
    unregPid(srv.name);
    try {
      if (lfd !== undefined) closeSync(lfd);
    } catch {}
    try {
      if (efd !== undefined) closeSync(efd);
    } catch {}
    slog(`${srv.name} 退出 (${sig ? `signal ${sig}` : `code ${code}`})`);
    const idx = children.indexOf(proc);
    if (idx >= 0) children.splice(idx, 1);
    // ═══ 看門狗：服務退出自動重啟（終端機關閉時跟著停止） ═══
    // 2026-11-06 Fix：原本條件 `code !== 0` 導致 graceful shutdown（收到 SIGTERM
    // 後自行 process.exit(0)）被視為「正常結束」而不重啟，safe-restart.sh 一用
    // 服務就消失。常駐服務只要不是 __shuttingDown 就應重啟。
    if (!globalThis.__shuttingDown) {
      const streak = (_restartStreak.get(srv.name) || 0) + 1;
      _restartStreak.set(srv.name, streak);
      const delayMs = Math.min(3000 * streak, 30000);
      slog(
        `🔄 ${srv.name} 退出，${Math.round(delayMs / 1000)}s 後自動重啟（第 ${streak} 次）...`,
      );
      setTimeout(() => {
        if (!globalThis.__shuttingDown) launch(srv);
      }, delayMs);
    }
  });
  proc.on("error", (err) => slog(`${srv.name} 錯誤: ${err.message}`));
  children.push(proc);
  // 穩定運行 60s → 清除重啟計數，避免正常重啟被誤判為連續失敗
  setTimeout(() => {
    if (children.includes(proc)) _restartStreak.delete(srv.name);
  }, 60000).unref?.();
  // 🚫 LOCKED §3: 服務啟動日誌格式 — `${name} 已啟動 (PID: ${pid})` 不得修改
  slog(`${srv.name} 已啟動 (PID: ${proc.pid})`);
}

// ─── 清理 — 只殺自己啟動的行程 ───
function cleanup() {
  globalThis.__shuttingDown = true;
  slog("正在關閉...");
  killSvcPids(); // 只殺 PID 檔有記錄的
  for (const proc of children) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  // 補刀：殺漏掉的孫行程（如 qwen2api 開的 Chrome headless）
  for (const p of [3000, 3456, 3457, 4377]) killOurByPort(p);
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    if (existsSync(SERVICE_PIDS)) unlinkSync(SERVICE_PIDS);
  } catch {}
  slog("已停止所有服務");
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);

// 清理舊日誌
function cleanLogs() {
  try {
    if (!existsSync(LOGS)) return;
    for (const f of readdirSync(LOGS)) {
      if (!f.startsWith("run-")) continue;
      const dir = join(LOGS, f);
      try {
        for (const sub of readdirSync(dir)) unlinkSync(join(dir, sub));
        rmdirSync(dir);
      } catch {}
    }
  } catch {}
}

// ─── 硬體偵測 ───
function detectHw() {
  const cpus = os.cpus();
  const cores = cpus.length;
  const model = cpus[0]?.model || "unknown";
  const totalGB = os.totalmem() / 1024 / 1024 / 1024;
  const freeGB = os.freemem() / 1024 / 1024 / 1024;
  const load = os.loadavg();
  const load1 = load[0] / cores;
  let cpuScore = cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
  let ramScore = totalGB >= 16 ? 3 : totalGB >= 8 ? 2 : totalGB >= 4 ? 1 : 0;
  if (freeGB >= 4) ramScore++;
  const totalScore = cpuScore + ramScore;

  // 筆電偵測
  let isLaptop = false;
  let onBattery = false;
  try {
    const bat = execSync("ls /sys/class/power_supply/BAT*/status 2>/dev/null", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (bat) {
      isLaptop = true;
      const st = execSync(`cat ${bat} 2>/dev/null`, {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      onBattery = st.toLowerCase().includes("discharging");
    }
  } catch {}

  // Tailscale 偵測
  let tsStatus = "";
  try {
    const st = execSync(
      "which tailscale 2>/dev/null && tailscale status 2>/dev/null",
      { timeout: 3000 },
    );
    if (st) {
      const lines = st.toString().trim().split("\n").filter(Boolean);
      tsStatus =
        lines.length >= 2 ? `✅ ${lines.length - 1} peer` : "⚠️ 僅本機";
    }
  } catch {}

  // 網速偵測（測 ping）
  let netLat = null;
  let netLabel = "";
  try {
    const start = Date.now();
    execSync("ping -c 1 -W 2 1.1.1.1 2>/dev/null", { timeout: 3000 });
    netLat = Date.now() - start;
    netLabel = netLat <= 50 ? "🟢" : netLat <= 150 ? "🟡" : "🔴";
    netLabel += ` ${netLat}ms`;
  } catch {
    netLabel = "⚠️ 逾時";
  }

  const level =
    totalScore <= 4 ? "small" : totalScore >= 10 ? "large" : "medium";
  const modelAdv =
    totalScore <= 4
      ? "small (輕量)"
      : totalScore <= 6
        ? "small (平衡)"
        : "large (全速)";

  return {
    cores,
    model,
    totalGB,
    freeGB,
    load1,
    cpuScore,
    ramScore,
    totalScore,
    level,
    isLaptop,
    onBattery,
    tsStatus,
    netLabel,
    modelAdv,
  };
}

// 🚫 LOCKED §5: 硬體報告 — 欄位順序（🖥💾🔌🌐📊🤖）及格式不得修改或移除
function hwReport(h) {
  if (!h) h = detectHw();
  const ll =
    h.level === "small" ? "輕量" : h.level === "large" ? "高效" : "中等";
  const power = h.isLaptop ? (h.onBattery ? "筆電·電池" : "筆電·電源") : "桌機";
  const lines = [
    `🖥  ${h.model} (${h.cores}核)`,
    `💾  RAM ${h.totalGB.toFixed(1)}GB (可用 ${h.freeGB.toFixed(1)}GB)`,
    `🔌  ${power}`,
    h.tsStatus ? `🌐  Tailscale ${h.tsStatus}` : null,
    `📊  等級: ${ll} (評分 ${h.totalScore}/10)`,
    `🤖  推薦模型 ${h.modelAdv}`,
  ].filter(Boolean);
  return lines.join("\n");
}

// ─── 健康報告 ───
async function genReport(apiKey) {
  const svcs = [
    { name: "qwen2api", url: "http://127.0.0.1:3000/health", port: 3000 },
    { name: "chat-proxy", url: "http://127.0.0.1:3456/health", port: 3456 },
    {
      name: "telegram-bridge",
      url: "http://127.0.0.1:4377/api/health",
      port: 4377,
    },
  ];
  let total = 0,
    healthy = 0;
  const parts = [];
  for (const s of svcs) {
    // 先快速探埠，不在本機的服務跳過
    if (!(await isPortOpen(s.port, 300))) continue;
    total++;
    const start = Date.now();
    const r = await checkSvc(s.url, 3000);
    const lat = Date.now() - start;
    if (r.ok) healthy++;
    parts.push(`${s.name}:${r.ok ? "✅" : "❌"}(${lat}ms)`);
  }
  const pct = Math.round((healthy / total) * 100);
  const icon = pct >= 90 ? "🟢" : pct >= 70 ? "🟡" : "🔴";

  // 🧠模型 測試：僅本地有 qwen2api 才做。若第一次超時（Chrome 預熱未完成），重試一次
  let modelPart = "";
  if (await isPortOpen(3000, 300)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const start = Date.now();
        const r = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "qwen3.6-27b",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(60000),
        });
        const lat = Date.now() - start;
        if (r.ok) {
          modelPart = `🧠模型:✅(${lat}ms)`;
          break;
        }
        // 非 2xx（上游 WAF 封禁/5xx）也必須回報，否則報告誤顯示 100% 健康
        // 與上方 `🧠模型:❌(timeout)` 同格式：`🧠模型:❌(upstream 狀態碼)`
        modelPart = `🧠模型:❌(upstream ${r.status})`;
        if (attempt === 0) continue; // 與 timeout 一致：重試一次
      } catch (e) {
        modelPart = `🧠模型:❌(timeout)`;
        if (attempt === 0) continue; // 重試一次
      }
    }
  }

  // 🚫 LOCKED §4: 健康報告格式 — 單行摘要 `${pct}% | svc1 svc2 | model` 不得修改
  return `${icon} **健康報告**: ${pct}% | ${parts.join(" ")}${modelPart ? ` | ${modelPart}` : ""}`;
}

// ─── 硬體偵測（同 detect.ts 風格，快取 30s） ───
let hwCache = null;
let hwCacheTime = 0;
const HW_TTL = 30_000;
function detectHwCached() {
  const now = Date.now();
  if (hwCache && now - hwCacheTime < HW_TTL) return hwCache;
  hwCache = detectHw();
  hwCacheTime = now;
  return hwCache;
}

// ─── 主流程 ───
async function main() {
  // 🚫 LOCKED §2: 開場橫幅 — 不得修改文字內容或移除
  console.log("[INFO] Starting qwen2api-dev services...");
  console.log("[INFO] Press Ctrl+C to stop all services.");
  console.log();
  slog(`qwen2api-dev 統一啟動器 (${os.platform()})`);
  slog(`Logs: ${LOGS}`);

  // 前置檢查
  if (!preflight()) {
    slog("前置檢查失敗，請修正後重試");
    process.exit(1);
  }

  // 殺舊行程（只殺自己啟動的）+ 強制釋放埠
  slog("清理舊行程...");
  killOldParent();
  killSvcPids(); // 只殺 SERVICE_PIDS 有記錄的
  killChromeOrphans();
  const PORTS = [3000, 3456, 3457, 4377];
  for (const p of PORTS) {
    const n = killOurByPort(p);
    if (n > 0) slog(`埠 ${p}: 殺了 ${n} 個殘留行程`);
  }
  // 確認所有埠已釋放
  for (const p of PORTS) {
    if (!(await waitPortFree(p))) slog(`⚠️ 埠 ${p} 可能仍有殘留`);
  }
  await sleep(500);

  // 清理舊日誌
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
  cleanLogs();

  // 啟動服務
  const apiKey = process.env.API_KEY || "sk-qwen2api-test-2026";
  const SRV = [
    {
      name: "qwen2api",
      port: 3000,
      cwd: join(ROOT, "qwen2api"),
      cmd: [BUN, "src/start.js", "--force"],
      env: { API_KEY: apiKey },
      waitUrl: "http://127.0.0.1:3000/health",
      waitTimeout: 30,
    },
    {
      name: "chat-proxy",
      port: 3456,
      cwd: join(ROOT, "qwen2api-plugin"),
      cmd: [BUN, "src/start-proxy.js"],
      env: {
        API_KEY: apiKey,
        FOREGROUND: "true",
        PROXY_LOG_LEVEL: "info",
        PROXY_PORT: "3456",
      },
      waitUrl: "http://127.0.0.1:3456/health",
      waitTimeout: 15,
    },
  ];
  if (process.env.TELEGRAM_BOT_TOKEN) {
    SRV.push({
      name: "telegram-bridge",
      port: 4377,
      cwd: join(ROOT, "telegram-memory-bridge"),
      cmd: [BUN, "src/index.ts"],
      env: {},
      waitUrl: "http://127.0.0.1:4377/api/health",
      waitTimeout: 20,
    });
  }

  for (const s of SRV) {
    console.log();
    slog(`啟動 ${s.name}...`);
    launch(s);
    await sleep(1500);
    if (s.waitUrl) {
      const ok = await waitFor(s.waitUrl, s.name, s.waitTimeout);
      if (!ok && s.name === "qwen2api") {
        slog("qwen2api 健康檢查失敗，重試...");
        killSvcPids();
        await sleep(1000);
        launch(s);
        await waitFor(s.waitUrl, s.name, s.waitTimeout);
      }
    }
  }

  // 硬體偵測報告（服務啟動後、健康報告前）
  const hw = detectHwCached();
  slog(`🟡 🖥 **硬體偵測**`);
  for (const l of hwReport(hw).split("\n")) slog(l);
  console.log();

  // 健康報告（單行，同 Windows 版格式）
  console.log(await genReport(apiKey));
  console.log();

  // 🚫 LOCKED §6: 服務摘要 — URL 格式與縮排（4空格 padding）不得修改
  slog("──────────────────────────────────────");
  slog(`  qwen2api:     http://127.0.0.1:3000`);
  slog(`  chat-proxy:   http://127.0.0.1:3456`);
  slog(`  telegram:     port 4377`);
  slog(`  🔑 手動注入:  http://127.0.0.1:3000/inject`);

  // 記憶檔案統計
  const memEntries = join(_MEM_DIR, "entries");
  let memCount = 0;
  try {
    if (existsSync(memEntries)) memCount = readdirSync(memEntries).length;
  } catch {}
  slog(`  🧠 對話記憶: ${memCount}筆`);

  // 🚫 LOCKED §7: 功能特徵列表 — emoji + 功能名 + 說明的格式順序不得修改
  const routeOk = process.env.PROXY_ROUTE !== "off";
  slog(`  🧠 推理模式: auto（自動偵測 QwQ/Plus/Max/Coder）`);
  if (routeOk) slog(`  🧠 模型路由: 啟用（自動依任務複雜度切換）`);
  slog(`  📚 自我學習系統: 啟用`);
  slog(`  🧬 進化引擎: 啟用（事件驅動）`);

  // 🚫 LOCKED §8: 知識工具狀態 — 三圖示 + 標籤格式不得修改
  const wikiIdx = join(_WK_DIR, "index.json");
  const wikiOk = existsSync(wikiIdx) ? "📚" : "❌";
  const kwOk =
    existsSync(_KW_DIR) && readdirSync(_KW_DIR).length > 0 ? "📖" : "❌";
  const lsOk =
    existsSync(_LS_DIR) && readdirSync(_LS_DIR).length > 0 ? "💡" : "❌";
  slog(`  📡 知識工具 ${wikiOk} ${kwOk} ${lsOk} （wiki/knowledge/lesson）`);
  slog("──────────────────────────────────────");
  slog("Press Ctrl+C to stop services.");

  // 🚫 LOCKED §9: 運行中心跳 — 事件驅動 + 10min 活著證明（format 除工作中/待命中外不得修改）
  // 有事工作→「工作中」，無事待命→「待命中」，10min 無事件發一次「待命中」證明還活著
  const _statusState = {
    timer: null,
    lastActivity: Date.now(),
    curMode: "init",
  };
  const HEARTBEAT_MS = 600_000;

  const _doSlog = (mode) => {
    const hw = detectHwCached();
    const freeGB = hw.freeGB.toFixed(1);
    const memEntries2 = join(_MEM_DIR, "entries");
    let mc = 0;
    try {
      if (existsSync(memEntries2)) mc = readdirSync(memEntries2).length;
    } catch {}
    const label = mode === "work" ? "🟢 工作中" : "🟢 待命中";
    slog(
      `${label} | 💾 ${freeGB}GB | 🧠 ${mc}筆 | 推理:auto | 路由:${process.env.PROXY_ROUTE !== "off" ? "✅" : "❌"} | 📚自我學習 | 🧬進化引擎 | 📡知識工具`,
    );
  };

  // 活動事件：立即切換「工作中」，2s 防抖避免連環刷
  const _onActivity = () => {
    _statusState.lastActivity = Date.now();
    if (_statusState.curMode === "work") return; // 已在工作中
    _statusState.curMode = "work";
    _statusState.timer = setTimeout(() => {
      _statusState.timer = null;
      _doSlog("work");
    }, 2000);
  };

  // 10 分鐘心跳：無活動→「待命中」，有活動就等下次心跳再檢查
  setInterval(() => {
    const elapsed = Date.now() - _statusState.lastActivity;
    if (elapsed > HEARTBEAT_MS && _statusState.curMode !== "idle") {
      _statusState.curMode = "idle";
      _doSlog("idle");
    }
  }, HEARTBEAT_MS);

  // 監聽記憶目錄：有新記憶寫入才觸發更新
  const memWatchDir = join(_MEM_DIR, "entries");
  if (existsSync(memWatchDir)) {
    try {
      watch(memWatchDir, (eventType) => {
        if (eventType === "rename" || eventType === "change") _onActivity();
      });
    } catch (e) {
      slog(`⚠️ 無法建立記憶目錄監聽 (${e.message})，降級為 10 分鐘輪詢`);
      setInterval(_onActivity, HEARTBEAT_MS);
    }
  }

  // 首次啟動 10 秒後更新
  setTimeout(() => {
    _statusState.curMode = "work";
    _doSlog("work");
  }, 10_000);

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("啟動失敗:", err.message);
});
