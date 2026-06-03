#!/usr/bin/env bun
/**
 * refresh-token.js - 跨平台 Token 自動更新
 *
 * 安全識別: opencode-qwen2api-dev / token-refresh
 * 用途: 自動更新 Qwen browser token
 * 行為: spawn auto-get-token.js (puppeteer), 寫入 log
 *
 * 用法:
 *   bun refresh-token.js              -- 排程用 (預設)
 *   bun refresh-token.js --once       -- 只執行一次
 *
 * 定時排程:
 *   Linux:   crontab (每6小時 cd 到目錄後執行 bun refresh-token.js)
 *   Windows: 工作排程器 (執行程式: bun, 引數: refresh-token.js)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { mkdirSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BUN = process.execPath;
const LOG = join(ROOT, "logs");
mkdirSync(LOG, { recursive: true });

const logMsg = (msg) => `[${new Date().toISOString()}] ${msg}`;

async function run() {
  const logFile = join(
    LOG,
    `refresh-token-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const script = join(ROOT, "qwen2api", "auto-get-token.js");

  const lines = [
    `\n=== ${logMsg("========")} Token 自動更新開始 ========`,
    `${logMsg("腳本")}: ${script}`,
  ];
  for (const l of lines) {
    console.log(l);
    appendFileSync(logFile, l + "\n");
  }

  return new Promise((resolve) => {
    const child = spawn(BUN, [script], {
      cwd: ROOT,
      env: { ...process.env, AUTO_TRIGGER: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onData = (d) => {
      const s = d.toString();
      process.stdout.write(s);
      appendFileSync(logFile, s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("exit", (code) => {
      const done = `${logMsg("結束")}，退出碼: ${code}\n`;
      console.log(done);
      appendFileSync(logFile, done);
      resolve(code);
    });
    child.on("error", (e) => {
      const err = `${logMsg("失敗")}: ${e.message}\n`;
      console.error(err);
      appendFileSync(logFile, err);
      resolve(1);
    });
  });
}

const isOnce = process.argv.includes("--once");
run().then((code) => {
  if (isOnce) process.exit(code ?? 0);
  setTimeout(() => process.exit(code ?? 0), 30_000);
});
