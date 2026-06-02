@echo off
cd /d "%~dp0"

whoami /groups 2>nul | findstr "S-1-16-12288" >nul
if %errorLevel% equ 0 goto :run

:: Elevate via wscript (GUI host = no console window)
wscript //nologo "%~dp0start.vbs"
exit

:run
title qwen2api-core (port 3000)
color 07
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
if exist "C:\Program Files\bun\bin\bun.exe" set "PATH=C:\Program Files\bun\bin;%PATH%"
if not exist "bun.exe" for /f "delims=" %%i in ('where bun.exe 2^>nul') do set "PATH=%%~dpi;%PATH%"

:: Load API_KEY from root .env (matches unified launcher behavior)
for /f "tokens=2 delims==" %%a in ('findstr /b "API_KEY=" "%~dp0..\.env" 2^>nul') do set "API_KEY=%%a"

echo.
echo [qwen2api] Qwen2API Core Service
echo [qwen2api] http://127.0.0.1:3000
echo [qwen2api] Close window or press Ctrl+C to stop
echo.
bun src/start.js --force %*
echo.
echo [qwen2api] Stopped
pause
