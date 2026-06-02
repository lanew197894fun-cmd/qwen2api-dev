#!/usr/bin/env bash
# qwen2api: Qwen2API Core 獨立啟動腳本（Linux）
# 前台執行，terminal 會保持開啟直到 Ctrl+C
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
PORT=3000
LOG_DIR="$ROOT/logs"
[ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR"

echo ""
echo "══════════ Qwen2API Core ══════════"
echo ""

# ─── 載入 API_KEY ───
if [ -f "$ROOT/.env" ]; then
  export $(grep -E '^API_KEY=' "$ROOT/.env" 2>/dev/null || true)
fi

# ─── 優雅關閉舊服務 ───
graceful_kill() {
  local port=$1
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  echo "  ⏳ 關閉舊服務 (port $port)..."
  for p in $pids; do kill -15 "$p" 2>/dev/null || true; done
  sleep 3
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  ⚠️  強制終止"
    for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  else
    echo "  ✅ 已關閉"
  fi
}

graceful_kill $PORT

# ─── 啟動（前台，terminal 保持開啟） ───
echo "🚀 啟動 Qwen2API Core (port $PORT)..."
echo ""
echo "  關閉: 按 Ctrl+C 停止服務"
echo "  日誌: tail -f $LOG_DIR/qwen2api.log"
echo ""
cd "$DIR"
exec bun src/start.js --force
