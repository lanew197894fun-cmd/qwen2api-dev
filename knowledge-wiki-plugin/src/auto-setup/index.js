// Auto-setup for knowledge-wiki-plugin
// 環境檢查 + 配置注入 + 資料目錄建立

import { existsSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, totalmem } from "node:os";
import { readFile, writeFile } from "node:fs/promises";

const PKG_ROOT = dirname(new URL(import.meta.url).pathname);
const PLUGIN_ROOT = join(PKG_ROOT, "..", "..");
const SYS_NM = join(
  PKG_ROOT,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "projects",
  "system",
  "packages",
  "opencode",
  "node_modules",
);
const SHARED_DEPS = ["@opencode-ai/plugin", "zod"];

const CONFIG_PATH = join(homedir(), ".opencode", "config.json");

const PLUGIN_CFG = {
  "knowledge-wiki-plugin": {
    provider: "file",
    basePath: ".opencode",
    categories: [
      "01-技術主題",
      "02-專案管理",
      "03-問題修復",
      "04-工具配置",
      "05-整合紀錄",
      "06-學習筆記",
      "07-功能更新",
      "08-討論決策",
      "09-記憶系統",
    ],
    defaults: {
      duplicateThreshold: 0.85,
      cacheTTL: 60000,
      maxFilesToCheck: 50,
    },
  },
};

// ── Environment check ──
function checkEnv() {
  const issues = [];
  const nodeVer = process.version.slice(1);
  const major = parseInt(nodeVer.split(".")[0], 10);
  if (major < 18) issues.push(`Node >= 18 required, got ${nodeVer}`);

  const memGB = totalmem() / 1024 / 1024 / 1024;
  if (memGB < 1) issues.push(`Low system memory: ${memGB.toFixed(1)}GB`);

  return issues;
}

// ── Symlinks ──
async function setupSymlinks() {
  const pluginNM = join(PLUGIN_ROOT, "node_modules");
  mkdirSync(pluginNM, { recursive: true });

  for (const dep of SHARED_DEPS) {
    const src = join(SYS_NM, dep);
    const dst = join(pluginNM, dep);
    if (!existsSync(src)) {
      console.warn(
        `[auto-setup] ${dep} not found in system node_modules, skipping`,
      );
      continue;
    }
    if (existsSync(dst)) continue;

    try {
      // Ensure parent dir exists (needed for scoped packages like @opencode-ai)
      const parent = dirname(dst);
      mkdirSync(parent, { recursive: true });

      // Resolve workspace symlinks (e.g. @opencode-ai/plugin -> ../../../plugin)
      let target = src;
      try {
        target = realpathSync(src);
      } catch {
        /* use original */
      }

      symlinkSync(target, dst, "junction");
      console.log(`[auto-setup] Symlinked ${dep} -> ${target}`);
    } catch (e) {
      console.warn(`[auto-setup] Symlink failed for ${dep}:`, e.message);
    }
  }
}

// ── Config injection ──
async function injectConfig() {
  try {
    let cfg = {};
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf8");
      cfg = JSON.parse(raw);
    }
    // Deep merge only our plugin section, don't touch other config
    const pluginKey = "knowledge-wiki-plugin";
    cfg[pluginKey] = { ...PLUGIN_CFG[pluginKey], ...(cfg[pluginKey] || {}) };
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    console.log("[auto-setup] Config injected");
  } catch (e) {
    console.warn("[auto-setup] Config injection failed:", e.message);
  }
}

// ── Data directories ──
function setupDirs() {
  const dirs = [
    join(PLUGIN_ROOT, ".opencode", "knowledge"),
    join(PLUGIN_ROOT, ".opencode", "lesson-learned"),
    join(PLUGIN_ROOT, ".wiki"),
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }
  console.log("[auto-setup] Data directories created");
}

// ── Main ──
export async function runAutoSetup() {
  console.log("[auto-setup] knowledge-wiki-plugin starting...");

  const issues = checkEnv();
  if (issues.length > 0) {
    console.warn("[auto-setup] Environment issues:", issues.join("; "));
  }

  setupDirs();
  await injectConfig();
  await setupSymlinks();

  console.log("[auto-setup] knowledge-wiki-plugin ready");
}

// Auto-run if called directly
runAutoSetup().catch(console.error);
