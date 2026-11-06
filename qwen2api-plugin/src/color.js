// color.js — 統一色彩日誌系統 (零相依, 2026-07-08)
// 語義色彩：
//   primary(藍) secondary(紫) tertiary(青綠) accent(橙)
//   success(綠) warning(黃) error(紅) info(青) muted(灰) highlight(金)
//
// 使用方式:
//   import { makeLogger } from "./color.js";
//   const log = makeLogger("proxy");           // TAG_COLORS 自動對應
//   const log = makeLogger("custom", "info");  // 指定調色盤顏色

const IS_WIN = process.platform === "win32";

// ── 色彩能力檢測 ──────────────────────────────────────────
function _supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "0" || process.env.FORCE_COLOR === "false")
    return false;
  // ═══ Fix 2026-10-18: 優先檢查明確的色彩宣告 ═══
  // 原本只認 xterm/screen 前綴，導致：
  //   - COLORTERM=truecolor（GNOME Terminal/Konsole）被忽略
  //   - alacritty / kitty / wezterm / foot 等常見終端機被誤判為不支援
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true")
    return true;
  if (
    process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit"
  )
    return true;
  if (!process.stdout.isTTY && !process.stderr.isTTY) return false;
  const term = process.env.TERM || "";
  // 幾乎所有現代終端機都以 xterm 為基底，加上常見的獨立實作
  if (
    term.startsWith("xterm") ||
    term.startsWith("screen") ||
    term.startsWith("tmux") ||
    term.startsWith("alacritty") ||
    term.startsWith("kitty") ||
    term.startsWith("wezterm") ||
    term.startsWith("foot") ||
    term.startsWith("vte") ||
    term.startsWith("rxvt") ||
    term.startsWith("linux") ||
    term === ""
  )
    return true;
  if (IS_WIN) return true;
  return false;
}

const USE_COLOR = _supportsColor();

// ── ANSI 轉義序列 ────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

// ── 24-bit 調色盤 ────────────────────────────────────────
const PALETTE = {
  primary: [92, 156, 245], // 藍
  secondary: [157, 124, 216], // 紫
  tertiary: [108, 192, 180], // 青綠（teal）
  accent: [250, 178, 131], // 橙
  success: [127, 216, 143], // 綠
  warning: [245, 167, 66], // 黃橙
  error: [224, 108, 117], // 紅
  info: [86, 182, 194], // 青
  muted: [128, 128, 128], // 灰
  highlight: [255, 215, 85], // 金
};

// ── 日誌級別顏色 ─────────────────────────────────────────
const LEVEL_COLORS = {
  trace: PALETTE.muted,
  debug: PALETTE.muted,
  info: PALETTE.info,
  warn: PALETTE.warning,
  error: PALETTE.error,
};

// ── Tag → 調色盤對應表 ──────────────────────────────────
const TAG_COLORS = {
  // 核心模組
  proxy: "primary",
  plugin: "primary",
  server: "primary",

  // 路由
  router: "info",

  // 認證
  auth: "success",
  "auth:oauth": "success",
  "auth:cookie": "success",
  "auth:apikey": "success",

  // 學習/進化
  learning: "secondary",
  "self-learning": "secondary",
  evolution: "secondary",
  tuning: "tertiary",

  // Provider
  provider: "primary",

  // 自動判斷
  "auto-judge": "warning",

  // 硬體
  hardware: "accent",

  // 平台/系統
  platform: "muted",
  "resolve-deps": "muted",
  system: "muted",
};

// ── 日誌級別過濾 ─────────────────────────────────────────
const LOG_LEVELS = {
  silent: 0,
  trace: 1,
  debug: 2,
  error: 3,
  warn: 4,
  info: 5,
};

const _levelNum = (() => {
  const raw = process.env.PROXY_LOG_LEVEL;
  if (raw && LOG_LEVELS[raw] !== undefined) return LOG_LEVELS[raw];
  if (process.env.PROXY_QUIET === "true" || process.env.PROXY_QUIET === "1")
    return 0;
  // 預設: error/warn/info 可見, debug/trace 靜默
  // 除錯: PROXY_LOG_LEVEL=debug（含 debug, error, warn, info）
  // 全開: PROXY_LOG_LEVEL=trace
  return LOG_LEVELS.info;
})();

// ── 內部工具 ─────────────────────────────────────────────

function _colorize(rgb, text) {
  if (!USE_COLOR || !text) return text || "";
  return fg(rgb[0], rgb[1], rgb[2]) + text + RESET;
}

function _bgColorize(rgb, text) {
  if (!USE_COLOR || !text) return text || "";
  return bg(rgb[0], rgb[1], rgb[2]) + fg(0, 0, 0) + text + RESET;
}

/** 解析 colorKey → PALETTE RGB（支援 TAG_COLORS 間接對應 + PALETTE 直接對應） */
function _resolveColor(colorKey) {
  const mapped = TAG_COLORS[colorKey];
  if (mapped && PALETTE[mapped]) return PALETTE[mapped];
  if (PALETTE[colorKey]) return PALETTE[colorKey];
  return PALETTE.primary;
}

/** 產生 [tag] 字串 */
function _tag(colorKey, name) {
  const col = _resolveColor(colorKey);
  const inner = USE_COLOR ? _colorize(col, name) : name;
  return "[" + inner + "]";
}

/** 產生級別標籤 (DIM + 顏色) */
function _level(lvl) {
  const col = LEVEL_COLORS[lvl] || PALETTE.muted;
  const text = lvl.toUpperCase().padEnd(5);
  return USE_COLOR ? DIM + _colorize(col, text) : text;
}

// ── 匯出 API ─────────────────────────────────────────────

/**
 * 建立具名 Logger
 * @param {string} tag        顯示標籤
 * @param {string} [colorKey] TAG_COLORS 或 PALETTE 的 key（預設 auto 從 tag 查 TAG_COLORS）
 * @returns {{ debug, info, warn, error, sysError, trace }}
 */
export function makeLogger(tag, colorKey) {
  const resolved = colorKey || tag;
  const tagStr = _tag(resolved, tag);
  const shouldLog = (lvl) => _levelNum >= (LOG_LEVELS[lvl] ?? 0);

  const emit = (lvl, method, args) => {
    if (!shouldLog(lvl)) return;
    method(tagStr, _level(lvl), args.join(" "));
  };

  return {
    trace: (...a) => emit("trace", console.log, a),
    debug: (...a) => emit("debug", console.log, a),
    info: (...a) => emit("info", console.log, a),
    warn: (...a) => emit("warn", console.log, a),
    error: (...a) => emit("error", console.error, a),
    /** 系統錯誤（stderr 粗體紅底） */
    sysError: (...a) => {
      if (!shouldLog("error")) return;
      const sysTag = _tag("muted", "系統");
      const prefix = USE_COLOR
        ? BOLD + bg(224, 108, 117) + "[系統錯誤]" + RESET
        : "[系統錯誤]";
      const msg =
        [sysTag, _level("error"), prefix, a.join(" ")].join(" ") + "\n";
      process.stderr.write(msg);
    },
  };
}

/**
 * 產生分隔線
 * @param {string} [colorKey] 顏色 key（預設 muted）
 * @param {string} [label]    中央標籤
 * @param {number} [width]    總寬度
 * @returns {string}
 */
export function makeDivider(colorKey = "muted", label = "", width = 60) {
  if (!USE_COLOR) return label ? `── ${label} ──` : "─".repeat(width);
  const col = _resolveColor(colorKey);
  const dash = "─".repeat(Math.max(2, width - label.length - 4));
  if (!label) return _colorize(col, "─".repeat(width));
  return _colorize(col, `─${dash} ${label} ${dash}─`);
}

/**
 * 產生標題橫幅（背景色 + 粗體）
 * @param {string} text      標題文字
 * @param {string} [colorKey] 顏色 key（預設 primary）
 * @returns {string}
 */
export function makeBanner(text, colorKey = "primary") {
  if (!USE_COLOR) return `=== ${text} ===`;
  const col = _resolveColor(colorKey);
  const pad = " ".repeat(4);
  const line = " ".repeat(text.length + 8);
  return (
    _bgColorize(col, line) +
    "\n" +
    _bgColorize(
      col,
      pad + BOLD + text + RESET + bg(col[0], col[1], col[2]) + pad,
    ) +
    "\n" +
    _bgColorize(col, line)
  );
}

/**
 * 解析顏色 → 直接獲取 RGB
 * @param {string} colorKey
 * @returns {number[]} [r, g, b]
 */
export function resolveRgb(colorKey) {
  return _resolveColor(colorKey);
}
