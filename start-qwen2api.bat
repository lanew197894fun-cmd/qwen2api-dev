@echo off
:: start-qwen2api.bat — 跨裝置角色感知啟動腳本
:: 自動偵測 DEVICE_ROLE（laptop/desktop），載入對應 API_KEY 與策略
:: 可透過環境變數 DEVICE_ROLE=laptop|desktop 強制指定

setlocal

:: ─── 裝置角色自動偵測 ───
:: 筆電 hostname 通常含 aspire/laptop/notebook/thinkpad
:: 桌機則不含這些關鍵字
if defined DEVICE_ROLE goto :role_set
hostname | findstr /i "aspire laptop notebook thinkpad" >nul 2>&1
if %errorlevel% equ 0 (
  set "DEVICE_ROLE=laptop"
) else (
  set "DEVICE_ROLE=desktop"
)
:role_set

echo [config] DEVICE_ROLE=%DEVICE_ROLE%

:: ─── 角色預設值 ───
if "%DEVICE_ROLE%"=="laptop" (
  set "DEFAULT_API_KEY=sk-123456"
  set "PROXY_MAX_INFLIGHT=2"
  set "PROXY_CB_THRESHOLD=3"
  set "PROXY_RETRIES=0"
) else (
  set "DEFAULT_API_KEY=CHANGE_ME"
  set "PROXY_MAX_INFLIGHT=8"
  set "PROXY_CB_THRESHOLD=5"
  set "PROXY_RETRIES=1"
)

:: API_KEY 優先順序：環境變數 → 角色預設
if not defined API_KEY set "API_KEY=%DEFAULT_API_KEY%"

:: ─── 路徑設定（跨裝置相容） ───
:: 自動偵測專案根目錄（支援筆電 Linux/macOS 與桌機 Windows）
if defined PROJECT_ROOT goto :paths_set
if exist "D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev" (
  set "PROJECT_ROOT=D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev"
) else if exist "%USERPROFILE%\opencode-manager\projects\independent\qwen2api-dev" (
  set "PROJECT_ROOT=%USERPROFILE%\opencode-manager\projects\independent\qwen2api-dev"
) else (
  echo [ERROR] 無法找到專案目錄，請設定 PROJECT_ROOT 環境變數
  exit /b 1
)
:paths_set

set "ROOT=%PROJECT_ROOT%"
set "BUN_DIR=%USERPROFILE%\.bun\bin"
if exist "%BUN_DIR%\bun.exe" (
  set "BUN=%BUN_DIR%\bun.exe"
  set "PATH=%BUN_DIR%;%PATH%"
) else if exist "C:\Program Files\bun\bin\bun.exe" (
  set "BUN=C:\Program Files\bun\bin\bun.exe"
  set "PATH=C:\Program Files\bun\bin;%PATH%"
) else (
  for /f "delims=" %%i in ('where bun.exe 2^>nul') do set "BUN=%%i"
)

:: Windows Terminal 可選啟動（動態偵測路徑）
:: 優先使用標準 wt 命令，若不存在則嘗試常見安裝路徑
set "WT_CMD=wt"
where wt >nul 2>&1
if %errorlevel% neq 0 (
  if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe" (
    set "WT_CMD=%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe"
  ) else if exist "%PROGRAMFILES%\WindowsApps\Microsoft.WindowsTerminal_*\wt.exe" (
    for /d %%i in ("%PROGRAMFILES%\WindowsApps\Microsoft.WindowsTerminal_*") do set "WT_CMD=%%i\wt.exe"
  )
)

if "%1" NEQ "--wt" (
  if not "%SCHTASKS%"=="1" (
    start "" "%WT_CMD%" cmd /k "%~f0 --wt"
    exit /b
  )
)

echo [%DATE% %TIME%] 🖥️  裝置角色: %DEVICE_ROLE%
echo [%DATE% %TIME%] 🔑 API_KEY: %API_KEY:~0,8%...
echo [%DATE% %TIME%] 📂 專案目錄: %ROOT%
echo [%DATE% %TIME%] ⚙️  MaxInflight=%PROXY_MAX_INFLIGHT%, CB_Threshold=%PROXY_CB_THRESHOLD%, Retries=%PROXY_RETRIES%
echo.

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

echo [%DATE% %TIME%] Starting chat-proxy (API_KEY=%API_KEY:~0,8%...)...
cd /d "%ROOT%\qwen2api-plugin"
set "PROXY_MAX_INFLIGHT=%PROXY_MAX_INFLIGHT%"
set "PROXY_CB_THRESHOLD=%PROXY_CB_THRESHOLD%"
set "PROXY_RETRIES=%PROXY_RETRIES%"
start "%BUN%" /B %BUN% src/start-proxy.js

echo [%DATE% %TIME%] Waiting for chat-proxy...
timeout /T 5 /NOBREAK >nul

echo [%DATE% %TIME%] Starting telegram-bridge...
cd /d "%ROOT%\telegram-memory-bridge"
start "%BUN%" /B %BUN% src/index.ts

echo.
echo [%DATE% %TIME%] ✅ All services started.
echo [%DATE% %TIME%] system-watchdog 已整合至 chat-proxy 健康報告中
echo [%DATE% %TIME%] This window will stay open to keep services alive.
echo [%DATE% %TIME%] Close this window to stop all services.
echo.

REM Keep alive for 24 hours
timeout /T 86400 /NOBREAK >nul
