/// <reference types="bun" />
// Telegram Memory Bridge — unified entry point
// 自動角色偵測 + 輕量化：僅載入必要模組

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { decrypt } from "./encryption.ts";
import { acquireLock } from "./lock.ts";
import { startMonitoring } from "./governor.ts";
import type { PlatformState, Role } from "./types/push.ts";
// 使用集中管理的跨裝置路徑
import {
  OPENCODE_DIR,
  MEMORY_DIR,
  KNOWLEDGE_DIR,
  WIKI_DIR,
  LESSON_DIR,
} from "../../config/paths.js";

const IS_WIN = platform() === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));

// 啟動完成旗標：health endpoint 在橋接器完全就緒前回 503
const readyRef = { current: false };

// 父行程心跳檢測：每 5 秒檢查 ppid 是否仍存活
// 若父行程死亡（終端機關閉、crash），子行程立即自盡，防止孤兒推送
{
  const PPID = process.ppid;
  setInterval(() => {
    try {
      process.kill(PPID, 0);
    } catch {
      process.exit(0);
    }
  }, 5000);
}

// ── Config ──

interface Config {
  token: string;
  apiPort: number;
  memoryPath: string;
  knowledgePath: string;
  wikiPath: string;
  lessonPath: string;
  opencodeRoot: string;
  qwenModel: string;
}

function loadPeers(): string[] {
  const raw = process.env.PEERS;
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  try {
    const cfg = JSON.parse(
      readFileSync(resolve(__dirname, "../config.json"), "utf-8"),
    ) as Record<string, unknown>;
    return (cfg.peers as string[]) ?? [];
  } catch {
    return [];
  }
}

async function execAsync(cmd: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const proc = spawn(cmd, [], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Exit code ${code}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getLocalTailscaleIP(): Promise<string> {
  if (process.env.TAILSCALE_WATCH === "off") return "";
  try {
    return await execAsync("tailscale ip -4", 2000);
  } catch {
    return "";
  }
}

function loadConfig(): Config {
  let envToken = process.env.TELEGRAM_BOT_TOKEN || "";

  if (!process.env.ENCRYPTION_KEY) {
    const kp = resolve(OPENCODE_DIR, "encryption.key");
    if (existsSync(kp))
      process.env.ENCRYPTION_KEY = readFileSync(kp, "utf-8").trim();
  }
  envToken = decrypt(envToken);
  if (process.env.API_KEY) process.env.API_KEY = decrypt(process.env.API_KEY!);
  return {
    token: envToken,
    apiPort: parseInt(process.env.API_PORT || "4377", 10),
    memoryPath: process.env.MEMORY_PATH || MEMORY_DIR,
    knowledgePath: process.env.KNOWLEDGE_PATH || KNOWLEDGE_DIR,
    wikiPath: process.env.WIKI_PATH || WIKI_DIR,
    lessonPath: process.env.LESSON_PATH || LESSON_DIR,
    opencodeRoot: OPENCODE_DIR,
    qwenModel: process.env.QWEN_MODEL || "Qwen3.6-Max-Preview",
  };
}

// ── 角色偵測（使用 device-config 抽象層） ──

import { detectDevice, type DeviceConfig } from "./device-config.ts";

async function detectRole(
  cfg: Config,
): Promise<PlatformState & { deviceCfg: DeviceConfig }> {
  const deviceCfg = await detectDevice(
    cfg.token,
    process.env.MASTER_IP,
    process.env.PEERS || loadPeers().join(","),
    cfg.opencodeRoot,
  );

  return {
    tailscale: !!deviceCfg.tailscaleIP,
    hasPeers: deviceCfg.peers.length > 0,
    hasToken: cfg.token.length > 0,
    role: deviceCfg.role as Role,
    localIP: deviceCfg.tailscaleIP || "",
    peers: deviceCfg.peers,
    deviceCfg,
  };
}

// ── Main ──

async function main() {
  const cfg = loadConfig();
  const state = await detectRole(cfg);

  const lbl = { master: "🟢 主機", peer: "🟡 節點", standalone: "⚪ 單機" }[
    state.role
  ];
  console.log(
    `[role] ${lbl} — ${state.hasToken ? "有 Token" : "無 Token"}, ${state.tailscale ? "🌐 Tailscale" : "🚫 無 TS"}, ${state.hasPeers ? `📡 ${state.peers.length}P` : "📡 無 P"}`,
  );

  // standalone: 無作用及早退出（僅在無 Token 且無 Tailscale 時）
  if (state.role === "standalone" && !state.hasToken && !state.tailscale) {
    console.log("🌐 Tailscale 未連線 → 推送平台隱藏");
    console.log("❌ 無 Token 也無平台，無作用可執行，退出");
    process.exit(0);
  }

  // 🐛 FIX: Peer 模式但無 Peers 列表 → 嘗試自動偵測 Master
  if (state.role === "peer" && !state.hasPeers && state.tailscale) {
    console.log("📡 Peer 模式但無 Peers 列表，嘗試自動偵測 Master...");
    // 不退出，讓 startPeer 的 checkAndStart 邏輯處理偵測
  }

  // ── 啟動 Governor 主動監控（P0 修復） ──
  startMonitoring(10_000); // 每 10 秒採集指標

  // ── MemStore（所有模式都需要，但 peer 只啟用輕量 API） ──
  const { MemStore } = await import("./store");
  const store = new MemStore(cfg.memoryPath, cfg.qwenModel);
  await store.init();

  // ── 啟動 API server（所有模式皆有 push receivers，角色決定 health response）
  const { startApi } = await import("./api");

  // 可延遲設定的 pull handler（master 啟動後才掛載 pullFromPeer）
  let _pullHandler: ((peerUrl: string) => Promise<void>) | undefined;

  if (state.role === "master") {
    const lock = await acquireLock(cfg.apiPort, state.peers);
    if (!lock.ok && state.tailscale && state.hasPeers) {
      (state as any).role = "peer";
      console.log("[lock] 降級為 🟡 節點模式");
    } else if (!lock.ok) process.exit(0);
  }
  startApi({
    port: cfg.apiPort,
    store,
    role: state.role,
    knowledgePath: cfg.knowledgePath,
    wikiPath: cfg.wikiPath,
    lessonPath: cfg.lessonPath,
    opencodeRoot: cfg.opencodeRoot,
    onPullRequest: (peerUrl) =>
      _pullHandler ? _pullHandler(peerUrl) : Promise.resolve(),
    readyRef,
  });
  console.log(`🌐 API: http://0.0.0.0:${cfg.apiPort}/api/health (tailnet)`);

  // ── master 模式：bot + indexer + watcher + tailscale 事件 ──
  if (state.role === "master") {
    await startMaster(cfg, store, state, (fn) => {
      _pullHandler = fn;
    });
    readyRef.current = true;
    console.log("\n✅ 系統就緒");
  }
  // ── peer 模式：fs.watch + push sender ──
  else if (state.role === "peer") {
    await startPeer(cfg, state);
  }
}

// ── master 啟動（dynamic import，不佔 peer 記憶體） ──

async function startMaster(
  cfg: Config,
  store: any,
  state: PlatformState,
  setPullHandler?: (fn: (peerUrl: string) => Promise<void>) => void,
) {
  console.log("\n╔══ Telegram Memory Bridge ─ 🟢 主機 ══╗\n");

  const { detect } = await import("./detect");
  const { TelegramBot } = await import("./bot");
  const { Indexer } = await import("./indexer");
  const { DirWatcher } = await import("./watcher");
  const { pullFromPeer } = await import("./peer-puller");
  const { initKnowledgeTools } = await import("./knowledge-tools");
  setPullHandler?.((peerUrl) =>
    pullFromPeer(
      peerUrl,
      store,
      cfg.knowledgePath,
      cfg.wikiPath,
      (s) => bot.sendMessage(s),
      undefined,
      cfg.lessonPath,
    ),
  );

  const hw = detect();
  console.log("🔍", hw.info);

  const procPaths = {
    memoryIndex: resolve(cfg.memoryPath, "memory-index.json"),
    memoryEntries: resolve(cfg.memoryPath, "entries"),
    knowledge: cfg.knowledgePath,
    wikiIndex: resolve(dirname(cfg.wikiPath), "wiki-index.json"),
    wiki: cfg.wikiPath,
  };

  const indexer = new Indexer({
    wikiDir: cfg.wikiPath,
    wikiIndex: procPaths.wikiIndex,
    knowledgeDir: cfg.knowledgePath,
  });
  await indexer.scan();

  const bot = new TelegramBot({
    token: cfg.token,
    store,
    peers: state.peers,
    processorPaths: procPaths,
    orgPaths: {
      wikiDir: cfg.wikiPath,
      wikiIndex: procPaths.wikiIndex,
      knowledgeDir: cfg.knowledgePath,
      progressPath: resolve(dirname(cfg.memoryPath), "org-progress.json"),
    },
    knowledgePath: cfg.knowledgePath,
    wikiPath: cfg.wikiPath,
    lessonPath: cfg.lessonPath,
  });

  // 初始化知識工具（knowledge/wiki/lesson 功能）
  await initKnowledgeTools(
    __dirname,
    cfg.knowledgePath,
    cfg.wikiPath,
    cfg.lessonPath,
  );
  console.log("📚 知識工具已就緒（knowledge/wiki/lesson）");

  await bot.start(hw.pollIntervalMs);
  console.log("🤖 Telegram Bot 已啟動");

  const watcher = new DirWatcher(
    indexer,
    {
      wikiDir: cfg.wikiPath,
      wikiIndex: procPaths.wikiIndex,
      knowledgeDir: cfg.knowledgePath,
    },
    (r: any) => {
      if (r.added > 0 || r.removed > 0) bot.notifyWork();
    },
  );
  watcher.start();

  // Tailscale 裝置監視（120s 一次 subprocess，設 TAILSCALE_WATCH=off 跳過）
  if (
    process.env.TAILSCALE_WATCH !== "off" &&
    state.tailscale &&
    state.localIP
  ) {
    console.log("🌐 Tailscale:");
    console.log(`   📍 ${state.localIP}`);
    startTailscaleWatcher(cfg, state.localIP, store, (s: string) =>
      bot.sendMessage(s),
    );
  } else if (process.env.TAILSCALE_WATCH === "off") {
    console.log("🌐 Tailscale: ⏭️ 跳過監視 (TAILSCALE_WATCH=off)");
  }

  process.on("SIGINT", () => {
    console.log("\n👋 關閉...");
    watcher.stop();
    bot.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    watcher.stop();
    bot.stop();
    process.exit(0);
  });
}

// ── peer 啟動（輕量，只載入 watch-and-push） ──

async function startPeer(cfg: Config, state: PlatformState) {
  console.log("\n╔══ Telegram Memory Bridge ─ 🟡 節點 ══╗\n");

  // MASTER_IP 指定 → 跳過 tailscale 偵測，直接連（筆電節省 tailscale status 輪詢）
  const forcedMaster = process.env.MASTER_IP || "";
  if (forcedMaster) {
    const peerUrl = `http://${forcedMaster}:${cfg.apiPort}`;
    console.log(`[peer] ✅ 強制指定 Master: ${peerUrl} (MASTER_IP)`);
    const { startWatchAndPush, stopWatchAndPush } = await import(
      "./watch-and-push"
    );
    await startWatchAndPush({
      peerUrl,
      memoryRoot: cfg.memoryPath,
      knowledgeRoot: cfg.knowledgePath,
      wikiRoot: cfg.wikiPath,
      lessonRoot: cfg.lessonPath,
    });
    console.log(`[peer] 📤 推送中 → ${peerUrl}`);
    return;
  }

  // 節點模式：持續偵測遠端主機角色，僅在確認 Master 在線時啟動推送
  const selfHostname = require("os").hostname();
  let _watchStopped = false;
  let _stopWatch: (() => void) | null = null;
  let retryCount = 0;
  const maxRetries = 10;

  const checkAndStart = async () => {
    let foundMaster = false;
    let masterUrl = "";
    const peersToCheck = state.peers.length > 0 ? [...state.peers] : [];

    if (peersToCheck.length === 0 && state.tailscale) {
      console.log("[peer] 📡 Peers 列表為空，嘗試自動掃描 Tailscale 網路...");
      try {
        const out = await execAsync("tailscale status --json", 3000);
        const data = JSON.parse(out) as Record<string, unknown>;
        const peerList = data.Peer as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (peerList) {
          for (const [, val] of Object.entries(peerList)) {
            const ip = (val.TailscaleIPs as string[])?.[0];
            if (ip && ip !== state.localIP) {
              peersToCheck.push(`http://${ip}:${cfg.apiPort}`);
            }
          }
        }
      } catch (e) {
        console.warn(`[peer] ⚠️ Tailscale 掃描失敗: ${(e as Error).message}`);
      }
    }

    for (const p of peersToCheck) {
      try {
        const url = `${p.replace(/\/+$/, "")}/api/health`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const body = (await res.json()) as Record<string, unknown>;
        if (
          body.mode === "master" &&
          body.hostname &&
          body.hostname !== selfHostname
        ) {
          console.log(`[peer] 🎉✅ 偵測到遠端 Master: ${body.hostname} (${p})`);
          console.log(`[peer] 🎉🎉🎉 連接成功！跨裝置同步就緒 🎉🎉🎉`);
          foundMaster = true;
          masterUrl = p;
          break;
        } else if (body.mode === "peer") {
          console.warn(
            `[peer] ⚠️ 遠端 ${p} 也是 Peer 模式，跳過推送（避免雙向衝突）`,
          );
        }
      } catch {
        continue;
      }
    }

    if (!foundMaster) {
      retryCount++;
      if (retryCount >= maxRetries) {
        console.error(`[peer] ❌ 達到最大重試次數 (${maxRetries})，停止偵測`);
        return;
      }
      console.log(
        `[peer] 🔄 未偵測到 Master，60 秒後重試... (${retryCount}/${maxRetries})`,
      );
      setTimeout(checkAndStart, 60_000);
      return;
    }
    retryCount = 0;
    const targets = [masterUrl];

    console.log(`[peer] 🎯 推送目標: ${targets[0]}`);
    const { startWatchAndPush, stopWatchAndPush } = await import(
      "./watch-and-push"
    );
    await startWatchAndPush({
      peerUrl: targets[0],
      memoryRoot: cfg.memoryPath,
      knowledgeRoot: cfg.knowledgePath,
      wikiRoot: cfg.wikiPath,
      lessonRoot: cfg.lessonPath,
    });
    _stopWatch = stopWatchAndPush;
    readyRef.current = true;
    console.log("\n✅ 系統就緒\n");

    const healthTimer = setInterval(async () => {
      try {
        const url = `${targets[0].replace(/\/+$/, "")}/api/health`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as Record<string, unknown>;
        if (body.mode === "master") return;
        console.warn(
          `[peer] ⚠️ 遠端不再為 Master (mode=${body.mode})，停止推送`,
        );
      } catch {
        console.warn("[peer] ⚠️ Master 健康檢查失敗，停止推送");
      }
      if (_stopWatch) {
        _stopWatch();
        _stopWatch = null;
      }
      clearInterval(healthTimer);
      setTimeout(checkAndStart, 60_000);
    }, 300_000);
  };

  // 先掃再印 ✅ 系統就緒
  await checkAndStart();

  process.on("SIGINT", () => {
    console.log("\n👋 關閉...");
    if (_stopWatch) _stopWatch();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    if (_stopWatch) _stopWatch();
    process.exit(0);
  });
}

// ── Tailscale 事件監視器（拉長間隔，降低系統負擔） ──

interface TSDev {
  ip: string;
  hostname: string;
  os: string;
  online: boolean;
}
interface KP {
  ip: string;
  hostname: string;
  os: string;
  online: boolean;
  bridge: boolean;
}
const MO = new Set(["android", "ios", "ipados"]);
const im = (os: string) => (MO.has(os.toLowerCase().trim()) ? "📱 " : "");

function startTailscaleWatcher(
  cfg: Config,
  localIP: string,
  store: any,
  onPull?: (s: string) => void,
) {
  const known = new Map<string, KP>();
  const pullCooldown = new Map<string, number>(); // ip → last pull timestamp
  const PULL_COOLDOWN_MS = 120_000; // 同一裝置 2 分鐘內不重複拉取

  const refresh = async () => {
    let devices: TSDev[] = [];
    try {
      const cmd = `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`;
      const out = await execAsync(cmd, 3000);
      const data = JSON.parse(out) as Record<string, unknown>;
      const peers = data.Peer as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (peers)
        devices = Object.values(peers).map((p: any) => ({
          ip: p.TailscaleIPs?.[0] || "",
          hostname: p.DNSName?.split(".")[0] || p.HostName || "",
          os: (p.OS || "").toLowerCase(),
          online: p.Online === true,
        }));
    } catch {
      return;
    }

    const others = devices.filter((d) => d.ip && d.ip !== localIP);
    for (const dev of others) {
      const prev = known.get(dev.ip);
      let bridge = false;
      if (dev.online)
        try {
          const r = await fetch(`http://${dev.ip}:${cfg.apiPort}/api/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (r.ok) {
            const b = (await r.json()) as any;
            bridge = b.hostname ? true : false;
          }
        } catch {}
      if (prev?.online === dev.online && prev?.bridge === bridge) continue;
      known.set(dev.ip, { ...dev, bridge });
      const pi = im(dev.os);
      if (!prev) {
        if (!dev.online)
          console.log(`   ${pi}⚪ ${dev.ip} (${dev.hostname}) — 離線`);
        else
          console.log(
            bridge
              ? `   ${pi}✅ ${dev.ip} (${dev.hostname}) — bridge 在線`
              : `   ${pi}🔵 ${dev.ip} (${dev.hostname}) — 系統在線`,
          );
      } else if (prev.online !== dev.online) {
        console.log(
          dev.online
            ? `   ${pi}✅ ${dev.ip} (${dev.hostname}) — 上線`
            : `   ${pi}⚪ ${dev.ip} (${dev.hostname}) — 離線`,
        );
      } else if (prev.bridge !== bridge) {
        console.log(
          bridge
            ? `   ${pi}✅ ${dev.ip} (${dev.hostname}) — bridge 在線`
            : `   ${pi}🔵 ${dev.ip} (${dev.hostname}) — bridge 離線`,
        );
      }
      if (bridge && !prev?.bridge) {
        const last = pullCooldown.get(dev.ip) || 0;
        if (Date.now() - last < PULL_COOLDOWN_MS) {
          console.log(`   ⏱️ ${dev.ip} (${dev.hostname}) pull 冷卻中，跳過`);
        } else {
          pullCooldown.set(dev.ip, Date.now());
          const { pullFromPeer } = await import("./peer-puller");
          pullFromPeer(
            `http://${dev.ip}:${cfg.apiPort}`,
            store,
            cfg.knowledgePath,
            cfg.wikiPath,
            onPull,
            dev.hostname,
            cfg.lessonPath,
          ).catch(() => {});
        }
      }
    }
  };

  // 初始掃描（平行 HTTP，加快速度）
  (async () => {
    let devices: TSDev[] = [];
    try {
      const out = await execAsync(
        `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`,
        3000,
      );
      const data = JSON.parse(out) as Record<string, unknown>;
      const peers = data.Peer as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (peers)
        devices = Object.values(peers).map((p: any) => ({
          ip: p.TailscaleIPs?.[0] || "",
          hostname: p.DNSName?.split(".")[0] || p.HostName || "",
          os: (p.OS || "").toLowerCase(),
          online: p.Online === true,
        }));
    } catch {}

    const others = devices.filter((d) => d.ip && d.ip !== localIP);
    console.log(`   📡 共 ${others.length} 台裝置`);
    // 平行 health check
    const results = await Promise.allSettled(
      others
        .filter((d) => d.online)
        .map(async (dev) => {
          try {
            const r = await fetch(
              `http://${dev.ip}:${cfg.apiPort}/api/health`,
              { signal: AbortSignal.timeout(3000) },
            );
            if (r.ok) {
              const b = (await r.json()) as any;
              return { ip: dev.ip, bridge: !!b.hostname };
            }
          } catch {}
          return { ip: dev.ip, bridge: false };
        }),
    );
    const bridges = new Map(
      results
        .filter(
          (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
        )
        .map((r) => [r.value.ip, r.value.bridge]),
    );

    for (const dev of others) {
      known.set(dev.ip, { ...dev, bridge: bridges.get(dev.ip) || false });
      const pi = im(dev.os);
      if (!dev.online)
        console.log(`   ${pi}⚪ ${dev.ip} (${dev.hostname}) — 離線`);
      else
        console.log(
          bridges.get(dev.ip)
            ? `   ${pi}✅ ${dev.ip} (${dev.hostname}) — bridge 在線`
            : `   ${pi}🔵 ${dev.ip} (${dev.hostname}) — 系統在線`,
        );
    }

    // 初始掃描的 pull 記錄冷卻時間
    for (const [ip, _b] of bridges) {
      if (_b) pullCooldown.set(ip, Date.now());
    }

    // 定時比對，120s 取代 30s，減少 75% subprocess 呼叫
    let hash = "";
    setInterval(async () => {
      try {
        const out = await execAsync(
          `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`,
          3000,
        );
        const cur = Bun.hash(out).toString(36);
        if (cur !== hash) {
          hash = cur;
          refresh().catch(() => {});
        }
      } catch {}
    }, 120_000);
  })().catch(() => {});
}

// ── 全域例外防護 ──
// 任何未捕捉的 rejection / 例外都不允許帶走整個 bot：
// 單一指令（/run bash、上游空回覆…）失敗只能影響該次請求。
let crash = 0;
process.on("unhandledRejection", (reason) => {
  crash++;
  console.error(
    `⚠️ [unhandledRejection #${crash}] ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
  decay();
});
process.on("uncaughtException", (err) => {
  crash++;
  console.error(`⚠️ [uncaughtException #${crash}] ${err.message}`);
  console.error(err.stack || "");
  // 連續 10 次才視為不可恢復（避免無限崩潰迴圈）
  if (crash >= 10) {
    console.error("❌ 例外過多無法恢復，退出");
    process.exit(1);
  }
  decay();
});

function decay() {
  setTimeout(() => {
    crash = Math.max(0, crash - 1);
  }, 60_000).unref();
}

main().catch((err) => {
  console.error("❌ 啟動失敗:", err);
  process.exit(1);
});
