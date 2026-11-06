@echo off
setlocal

:: --- Path Configuration ---
set "ROOT=D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev"
set "BUN=C:\Users\ReaMasTer\.bun\bin\bun.exe"

:: Verify Project Directory
if not exist "%ROOT%" (
  echo [ERROR] Project directory not found: %ROOT%
  pause
  exit /b 1
)

:: Verify Bun
if not exist "%BUN%" (
  echo [WARN] Bun not found at specified path, searching...
  for /f "delims=" %%i in ('where bun.exe 2^>nul') do set "BUN=%%i"
  if not exist "!BUN!" (
    echo [ERROR] bun.exe not found. Please install Bun.
    pause
    exit /b 1
  )
)

echo [INFO] Using Bun: %BUN%
echo [INFO] Project Root: %ROOT%
echo.

:: --- Cleanup Old Processes (port-specific only) ---
echo [%TIME%] Cleaning up old processes...
for %%p in (3000 3456 4377) do (
  for /f "skip=4 tokens=5" %%a in ('netstat -ano ^| find ":%%p"') do (
    taskkill /F /PID %%a 2>nul
  )
)
timeout /T 2 /NOBREAK >nul

:: --- Start Services ---

:: 1. qwen2api
echo [%TIME%] Starting qwen2api...
cd /d "%ROOT%\qwen2api"
start "qwen2api" /B "%BUN%" src/start.js --force
if errorlevel 1 (
  echo [ERROR] Failed to start qwen2api
  pause
  exit /b 1
)
timeout /T 5 /NOBREAK >nul

:: 2. chat-proxy
echo [%TIME%] Starting chat-proxy...
cd /d "%ROOT%\qwen2api-plugin"
set "API_KEY=sk-123456"
set "PROXY_MAX_INFLIGHT=8"
set "PROXY_CB_THRESHOLD=5"
set "PROXY_RETRIES=1"
start "chat-proxy" /B "%BUN%" src/start-proxy.js
if errorlevel 1 (
  echo [ERROR] Failed to start chat-proxy
  pause
  exit /b 1
)
timeout /T 3 /NOBREAK >nul

:: 3. telegram-bridge
echo [%TIME%] Starting telegram-bridge...
cd /d "%ROOT%\telegram-memory-bridge"
start "telegram-bridge" /B "%BUN%" src/index.ts
if errorlevel 1 (
  echo [ERROR] Failed to start telegram-bridge
  pause
  exit /b 1
)

echo.
echo [%TIME%] All services started successfully!
echo [%TIME%] Check logs for details.
echo [%TIME%] Press any key to close this window (services will run in background)...
pause >nul
