#!/bin/bash
# start.sh — 獨立啟動 telegram-memory-bridge（port 4377）
# 用法: bash start.sh

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUN="$(which bun 2>/dev/null)"
[ -z "$BUN" ] && { echo "❌ 找不到 bun"; exit 1; }

echo "🔵 telegram-memory-bridge (port 4377)"
echo "---"
cd "$ROOT"
$BUN src/index.ts
