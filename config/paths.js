/**
 * config/paths.js — 跨裝置路徑集中定義（qwen2api-dev 專案根目錄）
 *
 * 原則：
 *   1. 先讀 env（PROJECT_ROOT / 個別路徑 env）
 *   2. 依 process.platform 自動切換
 *   3. 所有衍生路徑從 ROOT 推算，改路徑只改一處
 *
 * 用法：
 *   import { ROOT, OPENCODE_DIR, QWEN2API_DIR, TELEGRAM_BRIDGE_DIR, KNOWLEDGE_WIKI_DIR } from "./config/paths.js"
 */

import { platform, homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ─── 跨裝置：偵測「使用者當前所用系統」決定程式碼路徑 ───
// 優先級：環境變數 TARGET_OS（win/mac/linux）> 實際 process.platform
// 語意：使用者從哪個系統下指令 → proxy 把檔案/路徑導向該系統格式。
// 例：TARGET_OS=win 且 proxy 跑 linux → 路徑用 D:\ 格式（跨裝置掛載/網路存取）。
// 擴充點：未來可從 Tailscale peer OS 或請求 header 推斷，填入 TARGET_OS。
const _RAW_TARGET = (process.env.TARGET_OS || "").toLowerCase();
const _TARGET_OS =
  _RAW_TARGET === "win" || _RAW_TARGET === "windows"
    ? "win"
    : _RAW_TARGET === "mac" || _RAW_TARGET === "macos"
      ? "mac"
      : _RAW_TARGET === "linux"
        ? "linux"
        : platform();

/** 取得目標系統（使用者所用 OS），供路徑/模型層切換 */
export function getTargetOS() {
  return _TARGET_OS;
}

// 實際運行平台（proxy 跑在哪）
const _HOST_OS = platform();
// 跨裝置警告：目標與實際不同 → 路徑依目標，執行仍依實際
if (_TARGET_OS !== _HOST_OS) {
  // 延遲到首次 import 後由呼叫方 log；此處僅標記
  globalThis.__CROSS_DEVICE_WARN = true;
}

// ─── 跨裝置專案根目錄（依 TARGET_OS 切換，非 process.platform）───
const _IS_WIN = _TARGET_OS === "win32" || _TARGET_OS === "win";

const _ROOT =
  process.env.PROJECT_ROOT ||
  (_IS_WIN
    ? "D:\\opencode\\opencode-manager"
    : join(homedir(), "opencode-manager"));

// ─── 衍生路徑（一律從 ROOT 推導，個別 env 可覆寫）───
// Windows 使用 backslash，Linux/macOS 使用 forward slash
function _join(...args) {
  if (_IS_WIN) {
    // 在 Windows 上，使用 backslash 連接路徑
    return args.map((a) => a.replace(/\//g, "\\")).join("\\");
  }
  return join(...args);
}

export const ROOT = _ROOT;

export const OPENCODE_DIR =
  process.env.OPENCODE_DIR ||
  process.env.OPENCODE_ROOT ||
  _join(_ROOT, "projects", ".opencode");

export const QWEN2API_DIR =
  process.env.QWEN2API_DIR ||
  process.env.QWEN2API_PATH ||
  _join(_ROOT, "projects/independent/qwen2api-dev/qwen2api");

export const TELEGRAM_BRIDGE_DIR =
  process.env.TELEGRAM_BRIDGE_DIR ||
  _join(_ROOT, "projects/independent/qwen2api-dev/telegram-memory-bridge");

export const KNOWLEDGE_WIKI_DIR =
  process.env.KNOWLEDGE_WIKI_DIR ||
  _join(_ROOT, "projects/independent/qwen2api-dev/knowledge-wiki-plugin");

export const SYSTEM_DIR =
  process.env.PROJECT_DIR || _join(_ROOT, "projects/system/packages/opencode");

export const LESSON_DIR = _join(OPENCODE_DIR, "skill/lesson");
export const WIKI_DIR = _join(OPENCODE_DIR, "wiki");
export const KNOWLEDGE_DIR = _join(OPENCODE_DIR, "knowledge");
export const MEMORY_DIR = _join(OPENCODE_DIR, "memory");
export const MODELS_DIR = _join(OPENCODE_DIR, "models");
export const CONVERSATIONS_DIR = _join(OPENCODE_DIR, "conversations");
export const SHADOW_DIR =
  process.env.SHADOW_DIR ||
  join(homedir(), ".local/share/opencode/shadow");

// ─── Tailscale 偵測（供全域使用） ───

let _tsCache = null;
let _tsTime = 0;
const _TS_TTL = 30_000;

export function hasTailscale() {
  return getTailscale().ts;
}

export function getTailscaleIP() {
  return getTailscale().ip;
}

export function getTailscale() {
  const now = Date.now();
  if (_tsCache && now - _tsTime < _TS_TTL) return _tsCache;
  _tsCache = _detectTailscale();
  _tsTime = now;
  return _tsCache;
}

function _detectTailscale() {
  try {
    const whichCmd = _IS_WIN
      ? "where tailscale 2>nul"
      : "command -v tailscale 2>/dev/null";
    const which = _tryExec(whichCmd);
    if (!which) return { ts: false, ip: "" };
    const ipCmd = _IS_WIN
      ? "tailscale ip -4 2>nul"
      : "tailscale ip -4 2>/dev/null";
    const ip = _tryExec(ipCmd);
    return { ts: true, ip: ip ?? "" };
  } catch {
    return { ts: false, ip: "" };
  }
}

function _tryExec(cmd, timeout = 3000) {
  try {
    return execSync(cmd, { timeout, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ─── 跨裝置警告：目標系統與實際運行平台不同時輸出提示 ───
// 路徑依 TARGET_OS 切換，但 proxy 實際執行仍依 hostOS。
// 例：TARGET_OS=win 跑在 linux → 寫入 D:\ 路徑需掛載/網路存取，否則檔案落點異常。
export function logCrossDeviceWarn() {
  if (_TARGET_OS !== _HOST_OS) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️ 跨裝置模式: 目標系統=${_TARGET_OS} 實際運行=${_HOST_OS}。路徑依目標切換，執行依實際。請確認目標路徑可存取（掛載/網路磁碟）。`,
    );
  }
  return {
    targetOS: _TARGET_OS,
    hostOS: _HOST_OS,
    cross: _TARGET_OS !== _HOST_OS,
  };
}
