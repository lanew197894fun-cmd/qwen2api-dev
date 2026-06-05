/**
 * config-manager — 統一配置中心
 *
 * 整合 qwen2api、qwen2api-plugin、system-watchdog、telegram-memory-bridge 的配置。
 * 提供單一來源的真相（Single Source of Truth），支援環境變數覆寫與預設值。
 */

import { z } from "zod";

// ─── Schema 定義 ───

const Qwen2ApiSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.number().int().positive().default(3000),
  API_KEY: z.string().default("CHANGE_ME"),
  DATA_SAVE_MODE: z.enum(["none", "local", "remote"]).default("none"),
  REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
});

const ProxySchema = z.object({
  PORT: z.number().int().positive().default(3456),
  MAX_BODY: z.number().int().positive().default(1048576),
  MAX_INFLIGHT: z.number().int().positive().default(8),
  REQUEST_TIMEOUT: z.number().int().positive().default(60000),
  CHAT_TIMEOUT: z.number().int().positive().default(300000),
  THINKING_TIMEOUT: z.number().int().positive().default(600000),
  HEALTH_TIMEOUT: z.number().int().positive().default(10000),
  RETRIES: z.number().int().nonnegative().default(2),
  CB_THRESHOLD: z.number().int().positive().default(5),
  CB_RECOVERY_MS: z.number().int().positive().default(30000),
  RATE_LIMIT: z.number().int().positive().default(600),
  RATE_WINDOW: z.number().int().positive().default(60000),
  ROUTE_ENABLED: z.boolean().default(true),
  THINKING_MODE: z.enum(["auto", "on", "off"]).default("auto"),
  LOG_LEVEL: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .default("warn"),
});

const WatchdogServiceSchema = z.object({
  name: z.string(),
  url: z.string(),
  healthPath: z.string().optional(),
});

const WatchdogSchema = z.object({
  ENABLED: z.boolean().default(true),
  CHECK_INTERVAL_MS: z.number().int().positive().default(30000),
  AUTO_RECOVERY: z.boolean().default(true),
  MAX_LAG_MS: z.number().int().positive().default(2000),
  SERVICES: z.array(WatchdogServiceSchema).default([
    { name: "qwen2api", url: "http://127.0.0.1:3000" },
    { name: "chat-proxy", url: "http://127.0.0.1:3456", healthPath: "/health" },
    {
      name: "telegram-bridge",
      url: "http://127.0.0.1:4377",
      healthPath: "/api/health",
    },
  ]),
});

const TelegramSchema = z.object({
  TOKEN: z.string().default(""),
  POLL_INTERVAL_MS: z.number().int().positive().default(2000),
  MAX_POLL_ERR_BACKOFF: z.number().int().positive().default(120000),
  PEERS: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  PROJECT_ROOT: z.string().default(() => {
    if (process.env.QWEN2API_ROOT) return process.env.QWEN2API_ROOT;
    const cwd = process.cwd();
    if (cwd.includes("qwen2api-dev")) {
      return cwd.split("qwen2api-dev")[0] + "qwen2api-dev";
    }
    return cwd;
  }),
  QWEN2API: Qwen2ApiSchema,
  PROXY: ProxySchema,
  WATCHDOG: WatchdogSchema,
  TELEGRAM: TelegramSchema,
});

// ─── 環境變數映射 ───

function loadFromEnv(): Partial<z.infer<typeof ConfigSchema>> {
  const env = process.env;
  const int = (v?: string): number | undefined =>
    v ? parseInt(v, 10) : undefined;
  const bool = (v?: string): boolean | undefined =>
    v ? v === "true" : undefined;

  return {
    PROJECT_ROOT: env.QWEN2API_ROOT,
    QWEN2API: {
      HOST: env.QWEN2API_HOST,
      PORT: int(env.SERVICE_PORT),
      API_KEY: env.API_KEY,
      DATA_SAVE_MODE: env.DATA_SAVE_MODE as any,
      REDIS_URL: env.REDIS_URL,
      LOG_LEVEL: env.LOG_LEVEL as any,
    },
    PROXY: {
      PORT: int(env.PROXY_PORT),
      MAX_BODY: int(env.PROXY_MAX_BODY),
      MAX_INFLIGHT: int(env.PROXY_MAX_INFLIGHT),
      REQUEST_TIMEOUT: int(env.PROXY_REQUEST_TIMEOUT),
      CHAT_TIMEOUT: int(env.PROXY_CHAT_TIMEOUT),
      THINKING_TIMEOUT: int(env.PROXY_THINKING_TIMEOUT),
      HEALTH_TIMEOUT: int(env.PROXY_HEALTH_TIMEOUT),
      RETRIES: int(env.PROXY_RETRIES),
      CB_THRESHOLD: int(env.PROXY_CB_THRESHOLD),
      CB_RECOVERY_MS: int(env.PROXY_CB_RECOVERY),
      RATE_LIMIT: int(env.PROXY_RATE_LIMIT),
      RATE_WINDOW: int(env.PROXY_RATE_WINDOW),
      ROUTE_ENABLED: env.PROXY_ROUTE ? env.PROXY_ROUTE !== "off" : undefined,
      THINKING_MODE: env.PROXY_THINKING_MODE as any,
      LOG_LEVEL: env.PROXY_LOG_LEVEL as any,
    },
    WATCHDOG: {
      ENABLED: bool(env.WATCHDOG_ENABLED),
      CHECK_INTERVAL_MS: int(env.WATCHDOG_CHECK_INTERVAL),
      AUTO_RECOVERY: bool(env.WATCHDOG_AUTO_RECOVERY),
      MAX_LAG_MS: int(env.WATCHDOG_MAX_LAG),
    },
    TELEGRAM: {
      TOKEN: env.TELEGRAM_BOT_TOKEN,
      POLL_INTERVAL_MS: int(env.TELEGRAM_POLL_INTERVAL),
      MAX_POLL_ERR_BACKOFF: int(env.TELEGRAM_MAX_POLL_ERR_BACKOFF),
      PEERS: env.TELEGRAM_PEERS ? env.TELEGRAM_PEERS.split(",") : undefined,
    },
  };
}

// ─── 單例實例 ───

let instance: z.infer<typeof ConfigSchema> | null = null;

export function getConfig(): z.infer<typeof ConfigSchema> {
  if (instance) return instance;

  const envConfig = loadFromEnv();
  // 合併預設值與環境變數，Zod 會處理驗證與預設值填充
  instance = ConfigSchema.parse(envConfig);
  return instance;
}

// ─── 輔助匯出 ───

export const CFG = getConfig();

// 向後相容：匯出舊版結構（供 chat-proxy.js 使用）
export const LEGACY_CFG = {
  PROXY_PORT: CFG.PROXY.PORT,
  QWEN2API_PORT: CFG.QWEN2API.PORT,
  QWEN2API_HOST: CFG.QWEN2API.HOST,
  API_KEY: CFG.QWEN2API.API_KEY,
  MAX_BODY: CFG.PROXY.MAX_BODY,
  MAX_INFLIGHT: CFG.PROXY.MAX_INFLIGHT,
  REQUEST_TIMEOUT: CFG.PROXY.REQUEST_TIMEOUT,
  CHAT_TIMEOUT: CFG.PROXY.CHAT_TIMEOUT,
  THINKING_TIMEOUT: CFG.PROXY.THINKING_TIMEOUT,
  HEALTH_TIMEOUT: CFG.PROXY.HEALTH_TIMEOUT,
  RETRIES: CFG.PROXY.RETRIES,
  CB_THRESHOLD: CFG.PROXY.CB_THRESHOLD,
  CB_RECOVERY_MS: CFG.PROXY.CB_RECOVERY_MS,
  RATE_LIMIT: CFG.PROXY.RATE_LIMIT,
  RATE_WINDOW: CFG.PROXY.RATE_WINDOW,
  ROUTE_ENABLED: CFG.PROXY.ROUTE_ENABLED,
  THINKING_MODE: CFG.PROXY.THINKING_MODE,
  LOG_LEVEL: (() => {
    const map: Record<string, number> = {
      silent: 0,
      error: 1,
      warn: 2,
      info: 3,
      debug: 4,
    };
    return map[CFG.PROXY.LOG_LEVEL] ?? 2;
  })(),
};
