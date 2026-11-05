// ─── 環境運作認知（邏輯版，非 prompt 注入）───
// 依賴鏈：opencode → chat-proxy(3456) → qwen2api(3000) → Chrome(qwen-profile) → chat.qwen.ai
// 模型經由本鏈取得推論；對鏈上行程下 kill/restart 會砍斷自己的回傳通道。
// 本模組在 tool_calls 送出給客戶端之前攔截自毀指令：
//   1. 可明確定位到單一服務 → 改寫為 safe-restart.sh（語法檢查 + 延遲 + SIGTERM + 健康驗證）
//   2. 完整重啟（bun dev / start.mjs）或目標不明 → 改寫為 echo 提示（不執行任何破壞動作）
//   3. 無關指令（ss / curl / git / pgrep …）→ 原樣放行
// 環境變數 ENV_GUARD=off 可停用（除錯用）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_CHAIN =
  "opencode → chat-proxy:3456 → qwen2api:3000 → Chrome(qwen-profile) → chat.qwen.ai";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAFE_RESTART = path.resolve(HERE, "../../scripts/safe-restart.sh");

const GUIDANCE = (what) =>
  `echo '[env-guard] 已攔截：${what}。完整重啟會切斷你自己的推論通道且需使用者確認；單服務重啟請用 bash ${SAFE_RESTART} <3456|3000|4377>'`;

const SAFE = (port) =>
  `echo '[env-guard] 已改寫為安全重啟：bash ${SAFE_RESTART} ${port}' && bash ${SAFE_RESTART} ${port}`;

// ─── 指令字串 → 目標服務判定 ───
// 回傳 3000 / 3456 / 4377 / "full"（完整重啟）/ "unknown"（無法判定）
const matchTargetFromString = (cmd) => {
  if (/start\.mjs/i.test(cmd)) return "full";
  if (/start-proxy|3456|chat-proxy/i.test(cmd)) return 3456;
  if (/telegram|4377/i.test(cmd)) return 4377;
  if (/3000|qwen2api|chrome-qwen-profile/i.test(cmd)) return 3000;
  if (/chrome|chromium/i.test(cmd)) return "full"; // 裸 chrome：無法確定是專用實例
  if (/qwen2api-dev/i.test(cmd)) return "full";
  return "unknown";
};

// ─── PID → 服務判定（/proc，Linux only；其他平台回傳 null）───
const matchTargetFromPid = (pid) => {
  let c = "";
  try {
    c = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {}
  if (c) {
    if (/start\.mjs/i.test(c)) return "full";
    if (/start-proxy\.js/i.test(c)) return 3456;
    if (/telegram-memory-bridge|telegram-bridge/i.test(c)) return 4377;
    if (/chrome-qwen-profile/i.test(c)) return 3000;
    if (/qwen2api/i.test(c)) return 3000;
    if (/qwen2api-dev/i.test(c)) return "full";
  }
  // fallback：cwd 在 qwen2api-dev 內（如 `bun src/start.js --force`，cmdline 無專案名）
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (/qwen2api-dev/i.test(cwd)) {
      if (/telegram/i.test(cwd) || /telegram/i.test(c)) return 4377;
      if (/telegram-memory-bridge/i.test(cwd)) return 4377;
      if (/start-proxy/i.test(c)) return 3456;
      if (/start\.mjs/i.test(c)) return "full";
      return 3000;
    }
  } catch {}
  return null;
};

const KILL_RE = /\b(kill|pkill|killall)\b/i;
const SVCCTL_RE = /\b(systemctl|service|initctl)\s+(stop|restart|kill|reload)\b/i;
// bun/npm/node dev|start 且明確指向本專案 → 完整重啟
const FULL_RE =
  /\b(bun|npm|pnpm|yarn|node)\s+(run\s+)?(dev|start(\.mjs|\.sh)?)\b/i;
const SELF_REF_RE = /qwen2api|qwen-proxy|qwen2api-dev|start-tmux|opencode-manager/i;

const ACTIONABLE_RE = new RegExp(
  [KILL_RE.source, SVCCTL_RE.source].join("|"),
  "i",
);

// 回傳 { target, how }：target ∈ 3000|3456|4377|"full"|null（null＝不干涉）
export const detectSelfDestructive = (cmd) => {
  if (!cmd || typeof cmd !== "string") return null;

  // 完整重啟：bun dev / bun start.mjs / ./start.sh，且指向本專案
  if (FULL_RE.test(cmd) && SELF_REF_RE.test(cmd)) return { target: "full", how: "full-restart" };
  if (/(start|dev)\.(sh|mjs|bat|ps1|vbs)\b/i.test(cmd) && SELF_REF_RE.test(cmd))
    return { target: "full", how: "full-restart" };

  if (!ACTIONABLE_RE.test(cmd)) return null;

  // systemctl/service 對千問服務 stop/restart → 提示（不逕自改寫系統服務指令）
  if (SVCCTL_RE.test(cmd) && /qwen|proxy|3456|3000|4377/i.test(cmd))
    return { target: "full", how: "svcctl" };

  // kill 系：優先看 PID 對應的實際行程，其次看指令字串目標
  const pids = [...cmd.matchAll(/\b\d{2,7}\b/g)].map((m) => m[0]);
  for (const pid of pids) {
    const t = matchTargetFromPid(pid);
    if (t) return { target: t, how: `pid:${pid}` };
  }
  const t = matchTargetFromString(cmd);
  if (t !== "unknown") return { target: t, how: "string" };
  return null; // 無法判定是不是我們的服務 → 放行
};

// 改寫單一 bash command；回傳 { command, reason } 或 null（不干涉）
export const rewriteCommand = (cmd) => {
  const hit = detectSelfDestructive(cmd);
  if (!hit) return null;
  const { target, how } = hit;
  if (target === "full") return { command: GUIDANCE(`完整/多服務重啟（${how}）`), reason: how };
  return { command: SAFE(target), reason: how };
};

// 攔截整批 tool_calls；僅處理 bash 工具，回傳新陣列（不修改入參）
export const guardToolCalls = (calls, log) => {
  if (process.env.ENV_GUARD === "off" || !Array.isArray(calls)) return calls;
  return calls.map((c) => {
    try {
      if (c?.function?.name !== "bash") return c;
      const args = JSON.parse(c.function?.arguments || "{}");
      const cmd = args?.command;
      if (typeof cmd !== "string") return c;
      const rw = rewriteCommand(cmd);
      if (!rw) return c;
      const orig = cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd;
      log?.warn?.(`[env-guard] 改寫自毀指令（${rw.reason}）: ${orig}`);
      return {
        ...c,
        function: {
          ...c.function,
          arguments: JSON.stringify({ ...args, command: rw.command }),
        },
      };
    } catch {
      return c; // 解析失敗 → 不干涉
    }
  });
};
