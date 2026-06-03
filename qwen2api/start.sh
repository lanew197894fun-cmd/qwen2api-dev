#!/bin/bash
# start.sh — 獨立啟動 qwen2api（port 3000）
# 用法: bash start.sh

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUN="$(which bun 2>/dev/null)"
[ -z "$BUN" ] && { echo "❌ 找不到 bun"; exit 1; }

echo "🔵 qwen2api (port 3000)"
echo "---"
cd "$ROOT"
$BUN src/start.js --force
