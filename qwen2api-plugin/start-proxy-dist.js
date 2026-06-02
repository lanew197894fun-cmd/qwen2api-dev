#!/usr/bin/env bun
/**
 * start-proxy-dist.js - Start Chat Proxy using compiled dist/ version
 * Usage: bun start-proxy-dist.js
 *
 * Bypasses src/chat-proxy.js encoding issue by using dist/chat-proxy.js
 */
import { startProxy } from "./dist/chat-proxy.js";

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LV = (() => {
  const raw = process.env.PROXY_LOG_LEVEL;
  if (raw && LOG_LEVELS[raw] !== undefined) return LOG_LEVELS[raw];
  if (process.env.PROXY_QUIET === "true" || process.env.PROXY_QUIET === "1") return 0;
  return 2;
})();
const log = {
  info: (...a) => { if (LV >= 3) console.log("[proxy]", ...a); },
  error: (...a) => { if (LV >= 1) console.error("[proxy]", ...a); },
};

process.on("unhandledRejection", (e) => {
  log.error("Unhandled rejection:", e?.message || e);
});
process.on("uncaughtException", (e) => {
  log.error("Uncaught exception:", e?.message || e);
});

try {
  var server = await startProxy();
} catch (e) {
  log.error(`Failed to start: ${e.message}`);
  process.exit(1);
}

const keepalive = setInterval(() => {}, 60000);

const shutdown = (sig) => {
  log.info(`Received ${sig}, shutting down...`);
  clearInterval(keepalive);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (e) => {
  log.error(`Uncaught exception: ${e.message}`);
  process.exit(1);
});
