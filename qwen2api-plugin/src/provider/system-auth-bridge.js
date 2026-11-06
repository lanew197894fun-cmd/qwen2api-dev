/**
 * system-auth-bridge.js — opencode 系統供應商憑證橋接
 *
 * 從 opencode 系統的 auth store (`~/.opencode/data/auth.json`) 讀取已登入的供應商憑證，
 * 轉換為 chat-proxy Provider 物件，作為 qwen2api 的 failover 備援。
 *
 * 使用方式：
 *   import { loadSystemProviders } from "./system-auth-bridge.js"
 *   const providers = loadSystemProviders()
 *   router.addProviders(providers)
 *
 * 支援的供應商（OpenAI 相容，可透過 API key 直接調用）：
 *   openai, openrouter, groq, deepinfra, mistral, perplexity,
 *   togetherai, cerebras, cohere, xai, deepseek, together, fireworks
 *
 * 不支援的（非 OpenAI 格式 / OAuth 複雜流程）：
 *   anthropic, google, github-copilot, amazon-bedrock, azure, cloudflare
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Provider } from "./provider.js";
import { makeLogger } from "../color.js";
import { OPENCODE_DIR } from "../config/paths.js";

const log = makeLogger("provider", "tertiary");

// ─── 已知供應商 API 端點對照 ───────────────────────────
// 僅收錄 OpenAI 相容格式，可透過標準 /v1/chat/completions + API key 調用
const KNOWN_PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    priority: 20,
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    priority: 15,
    label: "OpenRouter",
    models: [
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
    ],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    priority: 10,
    label: "Groq",
    models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  },
  deepinfra: {
    baseUrl: "https://api.deepinfra.com/v1/openai",
    priority: 10,
    label: "DeepInfra",
    models: ["meta-llama/Llama-3.3-70B-Instruct"],
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    priority: 10,
    label: "Mistral",
    models: ["mistral-large-latest", "mistral-small-latest"],
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    priority: 10,
    label: "Perplexity",
    models: ["sonar-pro", "sonar"],
  },
  togetherai: {
    baseUrl: "https://api.together.xyz/v1",
    priority: 8,
    label: "Together AI",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    priority: 8,
    label: "Cerebras",
    models: ["llama-3.3-70b"],
  },
  cohere: {
    baseUrl: "https://api.cohere.ai/v1",
    priority: 8,
    label: "Cohere",
    models: ["command-r-plus", "command-r"],
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    priority: 8,
    label: "xAI",
    models: ["grok-2", "grok-2-mini"],
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    priority: 8,
    label: "DeepSeek",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    priority: 8,
    label: "Together",
    models: [],
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    priority: 8,
    label: "Fireworks AI",
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
  },
};

const AUTH_STORE_PATH = path.join(OPENCODE_DIR, "data", "auth.json");

/**
 * 讀取 opencode 系統 auth store
 * @returns {object|null}  { providerId: { type, key } }
 */
function readAuthStore() {
  try {
    if (!fs.existsSync(AUTH_STORE_PATH)) return null;
    const raw = fs.readFileSync(AUTH_STORE_PATH, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    log.debug(`系統 auth store 讀取略過: ${e.message}`);
    return null;
  }
}

/**
 * 從系統 auth store 載入可用的 OpenAI 相容供應商 Provider 清單
 * @param {object} [opts]    { envOverrides, defaultPriority }
 * @returns {Provider[]}
 */
export function loadSystemProviders(opts = {}) {
  const store = readAuthStore();
  if (!store) {
    log.debug("系統 auth store 無資料，跳過系統供應商載入");
    return [];
  }

  const results = [];
  const entries = Object.entries(store);

  for (const [providerId, cred] of entries) {
    // 只處理 API key 類型
    if (!cred || cred.type !== "api" || !cred.key) continue;

    const known = KNOWN_PROVIDERS[providerId];
    if (!known) {
      log.debug(`跳過 ${providerId}: 非已知 OpenAI 相容供應商`);
      continue;
    }

    const baseUrl = known.baseUrl;
    const apiKey = cred.key.trim();
    if (!apiKey || !baseUrl) continue;

    const provider = new Provider(providerId, {
      baseUrl,
      apiKey,
      label: known.label,
      timeout: opts.timeout || 120000,
      retries: opts.retries ?? 1,
      priority: opts.defaultPriority ?? known.priority ?? 5,
      weight: 1,
      cbThreshold: opts.cbThreshold ?? 5,
      cbRecovery: opts.cbRecovery ?? 30000,
    });

    results.push(provider);
    log.info(
      `🔌 系統供應商: ${known.label} (${baseUrl}) pri=${provider.priority}`,
    );
  }

  return results;
}

/**
 * 列出所有支援的供應商 ID（用於錯誤提示）
 * @returns {string[]}
 */
export function getSupportedProviders() {
  return Object.keys(KNOWN_PROVIDERS);
}
