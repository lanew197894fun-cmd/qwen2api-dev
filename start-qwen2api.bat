@echo off
set "WT=D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev\terminal\terminal-1.24.11321.0\wt.exe"
set "BUN=C:\Users\ReaMasTer\.bun\bin\bun.exe"
set "ROOT=D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev"
set "PATH=C:\Users\ReaMasTer\.bun\bin;%PATH%"

:: Re-launch in Windows Terminal if running interactively (not schtasks/headless)
if not "%WT%"=="" (
  if "%1" NEQ "--wt" (
    if not "%SCHTASKS%"=="1" (
      start "" "%WT%" cmd /k "%~f0 --wt"
      exit /b
    )
  )
)

echo [%DATE% %TIME%] Killing old bun/port processes...
taskkill /F /IM bun.exe 2>nul
for %%p in (3000 3456 3457 4377) do (
  for /f "skip=4 tokens=5" %%a in ('netstat -ano ^| find "%%p"') do (
    taskkill /F /PID %%a 2>nul
  )
)
timeout /T 3 /NOBREAK >nul

echo [%DATE% %TIME%] Starting waf-proxy...
cd /d "%ROOT%\qwen2api-plugin"
start "%BUN%" /B %BUN% src/waf-proxy.js

echo [%DATE% %TIME%] Waiting for waf-proxy...
timeout /T 10 /NOBREAK >nul

echo [%DATE% %TIME%] Starting qwen2api...
cd /d "%ROOT%\qwen2api"
start "%BUN%" /B %BUN% src/start.js --force

echo [%DATE% %TIME%] Waiting for qwen2api...
timeout /T 8 /NOBREAK >nul

set API_KEY=sk-123456
echo [%DATE% %TIME%] Starting chat-proxy...
cd /d "%ROOT%\qwen2api-plugin"
start "%BUN%" /B %BUN% src/start-proxy.js

echo [%DATE% %TIME%] Waiting for chat-proxy...
timeout /T 5 /NOBREAK >nul

echo [%DATE% %TIME%] Starting telegram-bridge...
cd /d "%ROOT%\telegram-memory-bridge"
start "%BUN%" /B %BUN% src/index.ts

echo [%DATE% %TIME%] All services started.
echo system-watchdog 已整合至 chat-proxy 健康報告中
echo This window will stay open to keep services alive.
echo Close this window to stop all services.

REM Keep alive for 24 hours
timeout /T 86400 /NOBREAK >nul
