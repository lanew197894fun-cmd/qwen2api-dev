#!/bin/bash
# safe-restart.sh <3456|3000|4377> [--rollback]
# 千問代理安全重啟：語法檢查 → 延遲 SIGTERM → 健康輪詢 → 失敗回報（--rollback 才 git 回滾）。
# 禁止 kill -9；完整重啟（bun dev / start.mjs）不在此腳本範圍，需使用者確認。
set -euo pipefail

PORT="${1:-}"
ROLLBACK=0
[ "${2:-}" = "--rollback" ] && ROLLBACK=1
case "$PORT" in
  3456|3000|4377) ;;
  *) echo "用法: safe-restart.sh <3456|3000|4377> [--rollback]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(dirname "$SCRIPT_DIR")"
LOCK="/tmp/safe-restart-${PORT}.lock"

# ─── 簡易鎖（120s 過期防死鎖）───
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) )) -lt 120 ]; then
    echo "[safe-restart] 另一個重啟正在進行中（$LOCK），中止" >&2
    exit 3
  fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
trap 'rm -rf "$LOCK"' EXIT

echo "[safe-restart] 目標埠: $PORT（專案: $DEV_DIR）"

# ─── 1. 語法檢查（壞碼上不了線）───
check_fail() { echo "[safe-restart] ❌ 語法檢查失敗：$1（未動任何行程）" >&2; exit 1; }
case "$PORT" in
  3456)
    (cd "$DEV_DIR/qwen2api-plugin" && npx tsc --noEmit) || check_fail "qwen2api-plugin tsc"
    ;;
  3000)
    (cd "$DEV_DIR/qwen2api" && node --check src/server.js && node --check src/start.js) \
      || check_fail "qwen2api node --check"
    ;;
  4377)
    if [ -f "$DEV_DIR/telegram-memory-bridge/tsconfig.json" ]; then
      (cd "$DEV_DIR/telegram-memory-bridge" && npx tsc --noEmit) || check_fail "telegram-bridge tsc"
    else
      echo "[safe-restart] ⚠️ 無 tsconfig，跳過語法檢查"
    fi
    ;;
esac
echo "[safe-restart] ✅ 語法檢查通過"

# ─── 2. 找 PID ───
PID="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -z "$PID" ]; then
  echo "[safe-restart] 埠 $PORT 無行程，無需重啟（start.mjs 或使用者啟動後再試）"
  exit 0
fi
echo "[safe-restart] 目標 PID: $PID"

HEALTH_URL="http://127.0.0.1:${PORT}/health"
[ "$PORT" = "4377" ] && HEALTH_URL="http://127.0.0.1:4377/api/health"

# ─── 3. 延遲 SIGTERM（讓當回合工具結果先送達）───
nohup bash -c "sleep 8; kill -TERM $PID" >/dev/null 2>&1 &
echo "[safe-restart] 已排程 8 秒後 SIGTERM $PID（graceful drain，上限 15s）"

# ─── 4. 等重啟完成並輪詢健康（最多 ~55s）───
sleep 10
OK=0
for i in $(seq 1 45); do
  if curl -s -m 3 "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done

if [ "$OK" = "1" ]; then
  echo "[safe-restart] ✅ 埠 $PORT 重啟後健康檢查通過"
  exit 0
fi

echo "[safe-restart] ❌ 健康檢查失敗（$HEALTH_URL）" >&2
echo "[safe-restart] 最近的啟動日誌（tail start.log）：" >&2
tail -n 20 "$DEV_DIR/logs/start.log" >&2 || true
echo "[safe-restart] git status：" >&2
git -C "$DEV_DIR" status --short | head -20 >&2 || true

if [ "$ROLLBACK" = "1" ]; then
  echo "[safe-restart] --rollback：git checkout HEAD -- .（僅還原已追蹤檔案）" >&2
  git -C "$DEV_DIR" checkout HEAD -- .
  NEW_PID="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [ -n "$NEW_PID" ] && kill -TERM "$NEW_PID" && echo "[safe-restart] 已 SIGTERM $NEW_PID，請再次執行本腳本驗證" >&2
fi
exit 1
