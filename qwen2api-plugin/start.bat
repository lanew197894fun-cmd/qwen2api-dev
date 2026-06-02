@echo off
cd /d "%~dp0"
title qwen2api-chat-proxy (port 3456)

if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
if exist "C:\Program Files\bun\bin\bun.exe" set "PATH=C:\Program Files\bun\bin;%PATH%"
if not exist "bun.exe" for /f "delims=" %%i in ('where bun.exe 2^>nul') do set "PATH=%%~dpi;%PATH%"

:: Load API_KEY from root .env
for /f "tokens=2 delims==" %%a in ('findstr /b "API_KEY=" "%~dp0..\.env" 2^>nul') do set "API_KEY=%%a"

echo.
echo [chat-proxy] Chat Proxy + Hardware Detection
echo [chat-proxy] http://127.0.0.1:3456
echo [chat-proxy] Close window or press Ctrl+C to stop
echo.
bun src/start-proxy.js %*
echo.
echo [chat-proxy] Stopped
pause
