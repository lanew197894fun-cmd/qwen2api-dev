#Requires -Version 5.0
<#
.SYNOPSIS
  qwen2api-dev 跨平台啟動腳本（Windows 入口）
  相容 PowerShell 5（Windows Built-in）與 PowerShell 7
.DESCRIPTION
  委派給統一的 Bun 啟動器 start.js
  該腳本會自動偵測平台並選擇適當的啟動方式：
    - Windows：CIM + 獨立可見視窗（脫離 SSH Job Object）
    - Linux：背景行程
.EXAMPLE
  .\start.ps1
#>

$ErrorActionPreference = "Stop"

# 確認 Bun 可用
$bun = if (Get-Command bun -ErrorAction SilentlyContinue) {
  (Get-Command bun).Source
} elseif (Get-Command bun.exe -ErrorAction SilentlyContinue) {
  (Get-Command bun.exe).Source
} else {
  # 預設路徑
  "$env:USERPROFILE\.bun\bin\bun.exe"
}

if (-not (Test-Path $bun)) {
  Write-Host "[start] ERROR: Bun not found at $bun" -ForegroundColor Red
  Write-Host "[start] Install: https://bun.sh/docs/installation" -ForegroundColor Yellow
  exit 1
}

# 切換到腳本所在目錄
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDir

Write-Host "[start] Using Bun: $bun" -ForegroundColor Cyan
Write-Host "[start] Running: bun start.js" -ForegroundColor Cyan

try {
  # PS5 相容：用 & 呼叫執行檔
  # PS7 可用 &&，但 PS5 不行，所以用分離指令
  & $bun start.js
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "[start] ERROR: $_" -ForegroundColor Red
  $exitCode = 1
} finally {
  Pop-Location
}

if ($exitCode -ne 0 -and $exitCode -ne $null) {
  Write-Host "[start] Exited with code: $exitCode" -ForegroundColor Yellow
}

exit $exitCode
