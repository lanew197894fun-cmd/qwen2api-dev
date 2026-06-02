#!/usr/bin/env bash
# Telegram Memory Bridge — 快速啟動腳本
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── 載入加密金鑰（優先於 .env）──
KEYFILE="$HOME/.opencode/encryption.key"
if [ -z "$ENCRYPTION_KEY" ] && [ -f "$KEYFILE" ]; then
  export ENCRYPTION_KEY="$(tr -d '\n\r' < "$KEYFILE")"
  echo "[crypto] 🔑 已載入加密金鑰 (${ENCRYPTION_KEY:0:8}...)"
elif [ -z "$ENCRYPTION_KEY" ]; then
  echo "[crypto] ⚠️  ENCRYPTION_KEY 未設定，敏感欄位將以明文處理"
else
  echo "[crypto] 🔑 使用環境變數 ENCRYPTION_KEY"
fi

# 載入 .env（如存在）
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# 檢查必要環境變數
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "❌ TELEGRAM_BOT_TOKEN 未設定"
  echo "   1. 前往 https://t.me/BotFather 建立 Bot"
  echo "   2. 設定環境變數或建立 .env 檔案"
  echo ""
  echo "   快速建立 .env："
  echo "   echo 'TELEGRAM_BOT_TOKEN=你的_TOKEN' > .env"
  exit 1
fi

echo "🚀 啟動 Telegram Memory Bridge..."
exec bun run src/index.ts
