@echo off
cd /d "%~dp0"

whoami /groups 2>nul | findstr "S-1-16-12288" >nul
if %errorLevel% equ 0 goto :run

:: Elevate via wscript (GUI host = no console window)
wscript //nologo "%~dp0start.vbs"
exit

:run
title qwen2api-dev
color 07

if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
if exist "C:\Program Files\bun\bin\bun.exe" set "PATH=C:\Program Files\bun\bin;%PATH%"
if not exist "bun.exe" for /f "delims=" %%i in ('where bun.exe 2^>nul') do set "PATH=%%~dpi;%PATH%"

echo [start.bat] Starting qwen2api-dev (single terminal mode)...
echo [start.bat] Close this window or press Ctrl+C to stop.
echo.
bun start.js %*
echo.
echo [start.bat] Process exited. You can close this window.
pause
