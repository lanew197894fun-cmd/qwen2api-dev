#!/usr/bin/env bash
# 筆電端輕量 API 伺服器 — 供桌機 bridge 拉取資料
# 無 Bot、無 Token、零背景資源
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Laptop Memory API (standalone)    ║"
echo "║   筆電端輕量資料伺服器              ║"
echo "╚══════════════════════════════════════╝"
echo ""

exec bun src/api-server.ts
