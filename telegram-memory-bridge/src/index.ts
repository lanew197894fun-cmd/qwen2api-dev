/// <reference types="bun" />
// Telegram Memory Bridge — unified entry point
// 自動角色偵測 + 輕量化：僅載入必要模組

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { decrypt } from "./encryption";
import { acquireLock } from "./lock";
import type { PlatformState, Role } from "./types/push";

const IS_WIN = platform() === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

interface Config {
  token: string;
  apiPort: number;
  memoryPath: string;
  knowledgePath: string;
  wikiPath: string;
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

function getLocalTailscaleIP(): string {
  try {
    return execSync("tailscale ip -4", {
      timeout: 2000,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function loadConfig(): Config {
  let envToken = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!process.env.ENCRYPTION_KEY) {
    const kp = resolve(
      process.env.HOME || process.env.USERPROFILE || "",
      ".opencode/encryption.key",
    );
    if (existsSync(kp))
      process.env.ENCRYPTION_KEY = readFileSync(kp, "utf-8").trim();
  }
  envToken = decrypt(envToken);
  if (process.env.API_KEY) process.env.API_KEY = decrypt(process.env.API_KEY!);
  return {
    token: envToken,
    apiPort: parseInt(process.env.API_PORT || "4377", 10),
    memoryPath: resolve(
      __dirname,
      process.env.MEMORY_PATH || "../../../../.opencode/memory",
    ),
    knowledgePath: resolve(
      __dirname,
      process.env.KNOWLEDGE_PATH || "../../../../.opencode/knowledge",
    ),
    wikiPath: resolve(
      __dirname,
      process.env.WIKI_PATH || "../../../../.opencode/wiki",
    ),
    qwenModel: "small",
  };
}

// ── 角色偵測（不呼叫 detect，避免開局載入硬體偵測） ──

function detectRole(cfg: Config): PlatformState {
  const localIP = getLocalTailscaleIP();
  const peers = loadPeers();
  return {
    tailscale: localIP.length > 0,
    hasPeers: peers.length > 0,
    hasToken: cfg.token.length > 0,
    role:
      cfg.token && localIP && peers.length
        ? "master"
        : cfg.token
          ? "standalone"
          : localIP && peers.length
            ? "peer"
            : "standalone",
    localIP,
    peers,
  };
}

// ── Main ──

async function main() {
  const cfg = loadConfig();
  const state = detectRole(cfg);

  const lbl = { master: "🟢 主機", peer: "🟡 節點", standalone: "⚪ 單機" }[
    state.role
  ];
  console.log(
    `[role] ${lbl} — ${state.hasToken ? "有 Token" : "無 Token"}, ${state.tailscale ? "🌐 Tailscale" : "🚫 無 TS"}, ${state.hasPeers ? `📡 ${state.peers.length}P` : "📡 無 P"}`,
  );

  // standalone: 無作用及早退出
  if (state.role === "standalone" && !state.hasToken) {
    if (!state.tailscale) console.log("🌐 Tailscale 未連線 → 推送平台隱藏");
    else if (!state.hasPeers) console.log("📡 無 peer 設定 → 推送平台隱藏");
    console.log("❌ 無 Token 也無平台，無作用可執行，退出");
    process.exit(0);
  }

  // ── MemStore（所有模式都需要，但 peer 只啟用輕量 API） ──
  const { MemStore } = await import("./store");
  const store = new MemStore(cfg.memoryPath, cfg.qwenModel);
  await store.init();

  // ── 啟動 API server（所有模式皆有 push receivers，角色決定 health response）
  const { startApi } = await import("./api");
  if (state.role === "master") {
    const lock = await acquireLock(cfg.apiPort, state.peers);
    if (!lock.ok && state.tailscale && state.hasPeers) {
      (state as any).role = "peer";
      console.log("[lock] 降級為 🟡 節點模式");
    } else if (!lock.ok) process.exit(0);
  }
  startApi({ port: cfg.apiPort, store, role: state.role });
  console.log(`🌐 API: http://0.0.0.0:${cfg.apiPort}/api/health (tailnet)`);

  // ── master 模式：bot + indexer + watcher + tailscale 事件 ──
  if (state.role === "master") {
    await startMaster(cfg, store, state);
  }
  // ── peer 模式：fs.watch + push sender ──
  else if (state.role === "peer") {
    await startPeer(cfg, state);
  }

  console.log("\n✅ 系統就緒");
}

// ── master 啟動（dynamic import，不佔 peer 記憶體） ──

async function startMaster(cfg: Config, store: any, state: PlatformState) {
  console.log("\n╔══ Telegram Memory Bridge ─ 🟢 主機 ══╗\n");

  const { detect } = await import("./detect");
  const { TelegramBot } = await import("./bot");
  const { Indexer } = await import("./indexer");
  const { DirWatcher } = await import("./watcher");
  const { pullFromPeer } = await import("./peer-puller");

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
  });
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

  // Tailscale 裝置監視（120s 一次 subprocess，比以前 30s 省 75%）
  if (state.tailscale && state.localIP) {
    console.log("🌐 Tailscale:");
    console.log(`   📍 ${state.localIP}`);
    startTailscaleWatcher(cfg, state.localIP, store, (s: string) =>
      bot.sendMessage(s),
    );
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

  const targets = state.peers.filter(
    (p) => p.replace(/^https?:\/\//, "").replace(/:\d+$/, "") !== state.localIP,
  );
  if (!targets.length) {
    console.log("[peer] ⚠️ 無可推送目標，所有 peer 皆本機");
    return;
  }

  console.log(`[peer] 🎯 ${targets[0]}`);
  const { startWatchAndPush, stopWatchAndPush } = await import(
    "./watch-and-push"
  );
  await startWatchAndPush({
    peerUrl: targets[0],
    memoryRoot: cfg.memoryPath,
    knowledgeRoot: cfg.knowledgePath,
    wikiRoot: cfg.wikiPath,
  });

  process.on("SIGINT", () => {
    console.log("\n👋 關閉...");
    stopWatchAndPush();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopWatchAndPush();
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

  const refresh = async () => {
    let devices: TSDev[] = [];
    try {
      const cmd = `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`;
      const out = execSync(cmd, { timeout: 3000, encoding: "utf8" });
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
        const { pullFromPeer } = await import("./peer-puller");
        pullFromPeer(
          `http://${dev.ip}:${cfg.apiPort}`,
          store,
          cfg.knowledgePath,
          cfg.wikiPath,
          onPull,
          dev.hostname,
        ).catch(() => {});
      }
    }
  };

  // 初始掃描（平行 HTTP，加快速度）
  (async () => {
    let devices: TSDev[] = [];
    try {
      const out = execSync(
        `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`,
        { timeout: 3000, encoding: "utf8" },
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

    // 定時比對，120s 取代 30s，減少 75% subprocess 呼叫
    let hash = "";
    setInterval(() => {
      try {
        const out = execSync(
          `tailscale status --json${IS_WIN ? " 2>nul" : " 2>/dev/null"}`,
          { timeout: 3000, encoding: "utf8" },
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

main().catch((err) => {
  console.error("❌ 啟動失敗:", err);
  process.exit(1);
});
