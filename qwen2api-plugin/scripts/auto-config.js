#!/usr/bin/env bun
// Auto Config - 硬體自動偵測 → 智能寫入 OpenCode 設定
// 使用現有 qwen2api-plugin 的硬體偵測引擎
// 用法:
//   bun auto-config.js              ← 顯示建議
//   bun auto-config.js --apply      ← 套用設定
//   bun auto-config.js --json       ← JSON 輸出

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 從 src 引入現有硬體偵測
const HW_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "hardware-detect.js",
);
const { detectHardware } = await import(HW_PATH);

const CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".opencode",
  "opencode.json",
);

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// 硬體等級 → OpenCode 模型映射
const MODEL_MAP = {
  small: {
    model: "qwen-proxy/qwen-turbo",
    context: 16000,
    agent: {
      build: { model: "qwen-proxy/qwen-turbo", temperature: 0, top_p: 0.1 },
      coder: { model: "qwen-proxy/qwen-turbo" },
      vision: { model: "qwen-direct/Qwen3.6-Plus" },
      reasoning: { model: "qwen-proxy/qwen-turbo" },
    },
    desc: "輕量模式 - 最省資源",
  },
  medium: {
    model: "qwen-proxy/qwen-max",
    context: 32000,
    agent: {
      build: { model: "qwen-proxy/qwen-max", temperature: 0, top_p: 0.1 },
      coder: { model: "qwen-proxy/qwen-max" },
      vision: { model: "qwen-direct/Qwen3-VL-235B-A22B" },
      reasoning: { model: "qwen-proxy/qwen-max" },
    },
    desc: "均衡模式 - 輕快模型優先",
  },
  large: {
    model: "qwen-proxy/Qwen3.6-Plus",
    context: 131072,
    agent: {
      build: { model: "qwen-proxy/qwen-max", temperature: 0, top_p: 0.1 },
      coder: { model: "qwen-direct/Qwen3-Coder" },
      vision: { model: "qwen-direct/Qwen3-VL-235B-A22B" },
      reasoning: { model: "qwen-direct/Qwen3.6-Max-Preview" },
    },
    desc: "高效能 - 全模型開啓",
  },
};

function apply(cfg, map) {
  cfg.model = map.model;
  if (!cfg.agent) cfg.agent = {};
  for (const [agent, acfg] of Object.entries(map.agent || {})) {
    if (!cfg.agent[agent]) cfg.agent[agent] = {};
    cfg.agent[agent].model = acfg.model;
    if (acfg.temperature !== undefined)
      cfg.agent[agent].temperature = acfg.temperature;
    if (acfg.top_p !== undefined) cfg.agent[agent].top_p = acfg.top_p;
  }
  saveConfig(cfg);
  return cfg;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--apply")
    ? "apply"
    : args.includes("--json")
      ? "json"
      : "info";

  const hw = detectHardware();
  const map = MODEL_MAP[hw.level] || MODEL_MAP.medium;
  const cfg = loadConfig();

  if (mode === "json") {
    console.log(JSON.stringify({ hardware: hw, recommended: map }, null, 2));
    return;
  }

  const cur = cfg?.model || "unknown";

  console.log("");
  console.log("╔════════════════════════════════════════╗");
  console.log("║     OpenCode 硬體自動設定工具          ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");
  console.log(`  平台:    ${hw.platform}`);
  console.log(`  環境:    ${hw.env}`);
  console.log(`  CPU:     ${hw.cpu.model} (${hw.cpu.cores}核)`);
  console.log(`  RAM:     ${hw.ram.totalGB}GB (可用 ${hw.ram.freeGB}GB)`);
  console.log(`  GPU:     ${hw.gpu.model}`);
  console.log(`  負載:    ${hw.load.perCore}/core`);
  console.log(`  評分:    ${hw.scores.total}/12`);
  console.log(`  等級:    ${hw.level}`);
  console.log("");
  console.log(`  目前模型: ${cur}`);
  console.log(`  建議模型: ${map.model} (${map.desc})`);
  console.log(`  建議上下文: ${map.context} tokens`);
  console.log("");

  if (mode === "apply") {
    if (!cfg) {
      console.log("  ❌ 無法讀取設定檔");
      return;
    }
    const old = cfg.model;
    apply(cfg, map);
    console.log(`  ✅ 已套用: ${old} → ${cfg.model}`);
  } else {
    console.log("  執行 --apply 以套用建議設定");
    console.log("");
  }
}

main();
