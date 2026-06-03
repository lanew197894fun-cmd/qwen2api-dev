#!/bin/bash
# start.sh — 獨立啟動 waf-proxy（3457）+ chat-proxy（3456）
# 用法: bash start.sh

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUN="$(which bun 2>/dev/null)"
[ -z "$BUN" ] && { echo "❌ 找不到 bun"; exit 1; }

cleanup() {
  kill $WAF_PID $PROXY_PID 2>/dev/null
  exit
}
trap cleanup INT TERM

echo "🔵 waf-proxy (3457) + chat-proxy (3456)"
echo "---"

echo "[1/2] 啟動 waf-proxy..."
$BUN src/waf-proxy.js &
WAF_PID=$!
sleep 10

export API_KEY=sk-123456
echo "[2/2] 啟動 chat-proxy..."
$BUN src/start-proxy.js &
PROXY_PID=$!

echo "---"
echo "waf-proxy:   PID $WAF_PID"
echo "chat-proxy:  PID $PROXY_PID"
echo "按 Ctrl+C 停止"
wait
