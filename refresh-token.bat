@echo off
setlocal

cd /d "%~dp0"

:: 確保 bun 在 PATH 中
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

:: 日誌路徑
set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\refresh-token-%DATE:/=-%.log"

echo [%DATE% %TIME%] ======== Token 自動更新開始 ======== >> "%LOG_FILE%"
echo [%DATE% %TIME%] 執行目錄: %CD% >> "%LOG_FILE%"

:: 執行 auto-get-token.js（AUTO_TRIGGER=true 避免等待使用者按 Enter）
set "AUTO_TRIGGER=true"
bun qwen2api/auto-get-token.js >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%DATE% %TIME%] 結束，退出碼: %EXIT_CODE% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

exit /b %EXIT_CODE%
