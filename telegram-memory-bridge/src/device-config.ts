// device-config.ts — 裝置定義層
// 抽象化雙機架構（筆電 Peer / 桌機 Master），解耦角色判斷邏輯

import { platform, hostname } from "os";
import { resolve } from "path";
import { execSync } from "child_process";
// 使用集中管理的跨裝置路徑
import {
  OPENCODE_DIR,
  MEMORY_DIR,
  KNOWLEDGE_DIR,
  WIKI_DIR,
  LESSON_DIR,
} from "../../config/paths.js";

export type DeviceRole = "master" | "peer" | "standalone";

export interface DeviceConfig {
  role: DeviceRole;
  hostname: string;
  platform: string;
  isMobile: boolean;
  tailscaleIP?: string;
  masterIP?: string; // Peer 模式下指定的 Master IP
  peers: string[];
  memoryPath: string;
  knowledgePath: string;
  wikiPath: string;
  lessonPath: string;
}

/**
 * 檢查 Tailscale 狀態（同步版本，供啟動時快速偵測）
 */
function checkTailscaleSync(): {
  installed: boolean;
  connected: boolean;
  ip?: string;
} {
  try {
    // Windows 使用 where，Linux/macOS 使用 which
    const isWin = process.platform === "win32";
    const checkCmd = isWin ? "where tailscale" : "which tailscale";

    try {
      execSync(checkCmd, { stdio: "ignore" });
    } catch {
      return { installed: false, connected: false };
    }

    // 檢查連線狀態
    const statusCmd = isWin
      ? "tailscale status --json 2>nul"
      : "tailscale status --json 2>/dev/null";
    const status = execSync(statusCmd, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const data = JSON.parse(status);

    if (data.Self && data.Self.Online) {
      return {
        installed: true,
        connected: true,
        ip: data.Self.TailscaleIPs?.[0] || "unknown",
      };
    }
    return { installed: true, connected: false };
  } catch {
    return { installed: false, connected: false };
  }
}

/**
 * 檢查 Token 是否存在
 */
function checkToken(envToken: string): {
  hasToken: boolean;
  keyPreview?: string;
} {
  if (!envToken || envToken === "CHANGE_ME" || envToken === "sk-123456") {
    return { hasToken: false };
  }
  return {
    hasToken: true,
    keyPreview: "已設定",
  };
}

/**
 * 判斷裝置角色（基於主機名與環境變數）
 */
function detectDeviceRole(hostname: string): "laptop" | "desktop" | "server" {
  const roleEnv = (process.env.DEVICE_ROLE || "").toLowerCase();
  if (roleEnv === "laptop" || roleEnv === "desktop" || roleEnv === "server") {
    return roleEnv as "laptop" | "desktop" | "server";
  }

  // 根據 CPU 型號判斷伺服器級硬體（Xeon/Epyc/Opteron）
  let isServerHardware = false;
  try {
    const cpus = require("os").cpus();
    if (cpus.length > 0) {
      const model = cpus[0].model.toLowerCase();
      if (/xeon|epyc|opteron/i.test(model)) {
        isServerHardware = true;
      }
    }
  } catch {}

  const h = hostname.toLowerCase();
  if (/aspire|laptop|notebook|thinkpad|macbook/i.test(h)) return "laptop";
  if (/server|host|desktop|tower|main|primary|rig/i.test(h) || isServerHardware)
    return "server";
  return "desktop";
}

/**
 * 生成繁體中文狀態描述
 */
function generateStatusMessage(
  deviceRole: string,
  token: { hasToken: boolean; keyPreview?: string },
  tailscale: { installed: boolean; connected: boolean; ip?: string },
): string {
  const parts = [];
  if (token.hasToken) {
    parts.push(`🟡 有 Token (${token.keyPreview})`);
  } else {
    parts.push("⚪ 無 Token");
  }
  // Tailscale 狀態（三階段判斷）
  if (!tailscale.installed) {
    parts.push("📡 未安裝 Tailscale");
  } else if (!tailscale.connected) {
    parts.push("🌐 Tailscale (已安裝但未連線)");
  } else {
    parts.push(`🌐 Tailscale (${tailscale.ip})`);
  }
  const icon = deviceRole === "laptop" ? "🟡 節點" : "🖥️ 主機模式";
  return `${icon} — ${parts.join(", ")}`;
}

/**
 * 偵測裝置角色與配置
 * @param envToken Telegram Bot Token（用於判斷是否為 Master）
 * @param envMasterIP 強制指定的 Master IP（Peer 模式用）
 * @param envPeers Peer 列表（逗號分隔）
 * @param baseDir 基礎目錄（預設為專案根目錄）
 */
export async function detectDevice(
  envToken: string,
  envMasterIP?: string,
  envPeers?: string,
  baseDir?: string,
): Promise<DeviceConfig> {
  const h = hostname();
  const p = platform();
  const isMobile = ["android", "ios", "ipados"].includes(p);

  // 解析 Peers
  const peers = envPeers
    ? envPeers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // 環境自動偵測（Token + Tailscale + 角色）
  const tokenInfo = checkToken(envToken);
  const tailscaleInfo = checkTailscaleSync();
  const deviceRoleHint = detectDeviceRole(h);

  // 嘗試取得 Tailscale IP（若非同步失敗，使用同步結果）
  let tailscaleIP = tailscaleInfo.ip || "";
  if (!tailscaleIP && process.env.TAILSCALE_WATCH !== "off") {
    try {
      const { spawn } = await import("child_process");
      tailscaleIP = await new Promise<string>((resolve, reject) => {
        const proc = spawn("tailscale", ["ip", "-4"], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.on("close", (code) =>
          code === 0 ? resolve(out.trim()) : reject(),
        );
        proc.on("error", reject);
        setTimeout(() => {
          proc.kill();
          reject();
        }, 2000);
      });
    } catch {
      tailscaleIP = "";
    }
  }

  // 角色判斷邏輯
  let role: DeviceRole = "standalone";
  const hasToken = tokenInfo.hasToken;
  const hasPeers = peers.length > 0;
  const hasTailscale = !!tailscaleIP;
  const forcedMaster = envMasterIP || "";

  // 主機名關鍵字判斷（桌機/伺服器傾向於 Master）
  const isDesktopOrServer =
    deviceRoleHint === "server" || deviceRoleHint === "desktop";
  const isLaptop = deviceRoleHint === "laptop";

  if (hasToken && hasTailscale && hasPeers) {
    // 筆電即使有 Token+Tailscale+Peers，仍判定為節點（避免筆電搶主機）
    role = isLaptop ? "peer" : "master";
  } else if (forcedMaster && hasToken && hasPeers && !hasTailscale) {
    role = "peer";
  } else if (hasToken && hasTailscale && !hasPeers) {
    role = isDesktopOrServer ? "master" : "peer";
  } else if (hasToken) {
    role = "standalone";
  } else if (hasTailscale && hasPeers) {
    role = "peer";
  }

  // 輸出繁體狀態訊息
  const statusMsg = generateStatusMessage(
    deviceRoleHint,
    tokenInfo,
    tailscaleInfo,
  );
  console.log(`[env-detect] ${statusMsg}`);
  if (!tokenInfo.hasToken || !tailscaleInfo.connected) {
    console.warn(
      "[env-detect] ⚠️ 跨裝置同步條件不足，建議檢查 Token 與 Tailscale 連線",
    );
  }

  // ─── 跨裝置路徑集中定義（使用集中管理的 paths.js） ───
  // 環境變數優先，其次使用集中管理的路徑
  const opencodeDir = OPENCODE_DIR;

  return {
    role,
    hostname: h,
    platform: p,
    isMobile,
    tailscaleIP,
    masterIP: forcedMaster || undefined,
    peers,
    memoryPath: process.env.MEMORY_PATH || MEMORY_DIR,
    knowledgePath: process.env.KNOWLEDGE_PATH || KNOWLEDGE_DIR,
    wikiPath: process.env.WIKI_PATH || WIKI_DIR,
    lessonPath: process.env.LESSON_PATH || LESSON_DIR,
  };
}

/**
 * 取得裝置標籤（用於日誌顯示）
 */
export function getDeviceLabel(cfg: DeviceConfig): string {
  const icons: Record<DeviceRole, string> = {
    master: "🟢 主機",
    peer: "🟡 節點",
    standalone: "⚪ 單機",
  };
  const mobileTag = cfg.isMobile ? " 📱" : "";
  return `${icons[cfg.role]} ${cfg.hostname}${mobileTag}`;
}
