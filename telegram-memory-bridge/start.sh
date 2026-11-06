#!/bin/bash
# start.sh — 獨立啟動 telegram-memory-bridge（port 4377）
# 用法: bash start.sh

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
[ ! -x "$BUN" ] && { echo "❌ 找不到 bun（嘗試: curl -fsSL https://bun.sh/install | bash）"; exit 1; }

# 偵測 Tailscale
if ! command -v tailscale &>/dev/null; then
  echo "   ⚠️  未安裝 Tailscale（建議: curl -fsSL https://tailscale.com/install.sh | sh）"
fi

# 健康檢查：若埠 4377 已有健康服務，跳過不啟動（避免誤殺）
PID="$(lsof -ti :4377 -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PID" ]; then
  echo "   ⚠️  埠 4377 被僵屍或舊有 Process (PID $PID) 佔用，正在終止..."
  kill "$PID" 2>/dev/null
  sleep 1
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  echo "      ✅ 已釋放"
fi

echo "🔵 telegram-memory-bridge (port 4377)"
echo "---"
echo ""
echo "   📍 $ROOT"
echo "      ▶️  bash start.sh"
echo ""
cd "$ROOT"
exec "$BUN" src/index.ts
