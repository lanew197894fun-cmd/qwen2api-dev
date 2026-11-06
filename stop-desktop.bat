@echo off
chcp 65001 >nul
title qwen2api-dev 服務停止

cd /d "%~dp0"

echo ╔══════════════════════════════════════════╗
echo ║   停止 qwen2api-dev 所有服務              ║
echo ╚══════════════════════════════════════════╝
echo.

:: ─── 依 PID 檔案停止本專案進程（最精準）───
set "PIDDIR=%TEMP%\qwen2api-dev"
if exist "%PIDDIR%\qwen2api.pid" set /p PID=<"%PIDDIR%\qwen2api.pid" & taskkill /F /PID !PID! >nul 2>&1 & echo   終止 qwen2api (PID !PID!)
if exist "%PIDDIR%\chat-proxy.pid" set /p PID=<"%PIDDIR%\chat-proxy.pid" & taskkill /F /PID !PID! >nul 2>&1 & echo   終止 chat-proxy (PID !PID!)
if exist "%PIDDIR%\telegram.pid" set /p PID=<"%PIDDIR%\telegram.pid" & taskkill /F /PID !PID! >nul 2>&1 & echo   終止 telegram-bridge (PID !PID!)

:: ─── 無 PID 檔案時降級埠口掃描 ───
for %%p in (4377 3456 3000) do (
  echo 清理 port %%p ...
  for /f "skip=4 tokens=5" %%a in ('netstat -ano ^| find ":%%p" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
  )
)

echo.
echo ✅ 所有服務已停止
pause
