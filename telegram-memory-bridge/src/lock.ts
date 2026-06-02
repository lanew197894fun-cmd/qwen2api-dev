// Telegram Memory Bridge — lock.ts
// 防雙開：PID lock + 本地埠檢查 + 跨裝置檢查（僅 master 模式使用）

import { hostname, homedir } from "os";
import { resolve } from "path";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { execSync } from "child_process";

const pidDir = resolve(homedir(), ".opencode");
const pidFile = resolve(pidDir, "telegram-bridge.pid");

// 確保目錄存在
try {
  mkdirSync(pidDir, { recursive: true });
} catch {
  /* ignore */
}

export interface PeerConfig {
  peers: string[];
}

export interface LockOk {
  ok: true;
}

export interface LockFail {
  ok: false;
  reason: string;
}

export type LockResult = LockOk | LockFail;

// ── 本地 PID lock ──

function writePid(): void {
  writeFileSync(pidFile, String(process.pid), "utf-8");
}

function readPid(): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    return parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0) === true;
  } catch {
    return false;
  }
}

function cleanup(): void {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
}

function registerCleanup(): void {
  const fn = (): void => {
    cleanup();
  };
  process.on("exit", fn);
  process.on("SIGINT", fn);
  process.on("SIGTERM", fn);
}

// ── 埠佔用清除（KILL_OCCUPIED 模式用） ──

function killProcessOnPort(port: number): void {
  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: "utf8",
        timeout: 3000,
      });
      for (const line of out.split("\n").filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid))
          execSync(`taskkill /F /PID ${pid} 2>nul`, { timeout: 3000 });
      }
    } else {
      execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null`, {
        timeout: 3000,
      });
    }
  } catch {
    /* best effort */
  }
}

// ── 本地埠檢查 ──

async function checkLocalPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 跨裝置 peer 檢查 ──

async function checkPeers(
  peers: string[],
  selfHostname: string,
): Promise<string | null> {
  for (const p of peers) {
    try {
      const url = `${p.replace(/\/+$/, "")}/api/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const body = (await res.json()) as Record<string, unknown>;
      if (
        body.mode === "master" &&
        body.hostname &&
        body.hostname !== selfHostname
      )
        return p;
    } catch {
      continue;
    }
  }
  return null;
}

// ── 主入口（僅 master 模式呼叫） ──

export async function acquireLock(
  port: number,
  peers: string[],
): Promise<LockResult> {
  const self = hostname();

  // 0. 跨裝置檢查：如有遠端 master 在線，阻止雙主機
  const activePeer = await checkPeers(peers, self);
  if (activePeer)
    return {
      ok: false,
      reason: `❌ 遠端 ${activePeer} 已有 master 在線，為避免雙主機衝突，退出`,
    };

  // 1. PID lock
  const existingPid = readPid();
  if (existingPid && isAlive(existingPid))
    return {
      ok: false,
      reason: `❌ PID lock 衝突: 進程 ${existingPid} 已在執行`,
    };
  writePid();
  registerCleanup();

  // 2. 本地埠檢查
  if (await checkLocalPort(port)) {
    console.log(`[lock] 埠 ${port} 已被佔用，本地已有實例`);
    if (process.env.KILL_OCCUPIED === "true") {
      console.log(`[lock] KILL_OCCUPIED 模式：清除佔用行程...`);
      killProcessOnPort(port);
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (!(await checkLocalPort(port))) break;
      }
      if (!(await checkLocalPort(port))) {
        console.log(`[lock] ✅ 埠 ${port} 已釋放`);
      } else {
        cleanup();
        return {
          ok: false,
          reason: `❌ 埠 ${port} 無法釋放，即使 KILL_OCCUPIED 也失敗`,
        };
      }
    } else {
      cleanup();
      return { ok: false, reason: `❌ 埠 ${port} 已被佔用（本地已有 master）` };
    }
  }

  return { ok: true };
}
