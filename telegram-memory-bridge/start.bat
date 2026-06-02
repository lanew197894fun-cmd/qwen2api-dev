@echo off
REM Telegram Memory Bridge — Windows 快速啟動腳本
cd /d "%~dp0"

REM 載入 .env（如存在）
if exist .env (
  for /f "tokens=*" %%a in (.env) do set %%a
)

REM 檢查 TELEGRAM_BOT_TOKEN
if "%TELEGRAM_BOT_TOKEN%"=="" (
  echo [ERROR] TELEGRAM_BOT_TOKEN 未設定
  echo.
  echo 1. 前往 https://t.me/BotFather 建立 Bot
  echo 2. 設定環境變數：set TELEGRAM_BOT_TOKEN=你的_TOKEN
  echo    或建立 .env 檔案
  pause
  exit /b 1
)

echo [INFO] 啟動 Telegram Memory Bridge...
bun run src/index.ts
pause
