#Requires -Version 5.0
<#
.SYNOPSIS
  Telegram Memory Bridge — Windows 啟動腳本（PS5 / PS7 相容）
.DESCRIPTION
  載入 .env → 檢查 Bun → 啟動 Telegram Memory Bridge
  相容 PowerShell 5（Windows Built-in）與 PowerShell 7
.EXAMPLE
  .\start.ps1
#>

$ErrorActionPreference = "Stop"

# ── 標題 ──
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Telegram Memory Bridge v1.0       ║" -ForegroundColor Cyan
Write-Host "║   Windows 啟動腳本（PS5/PS7）       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 切換到腳本目錄 ──
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDir

# ── 載入 .env ──
$envFile = Join-Path $scriptDir ".env"
if (Test-Path $envFile) {
  Write-Host "[env] 載入 .env..." -ForegroundColor Yellow
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#=]+)=(.+)\s*$") {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim()
      Set-Item -Path "env:$key" -Value $val -ErrorAction SilentlyContinue
    }
  }
  Write-Host "[env] ✅ 已載入" -ForegroundColor Green
} else {
  Write-Host "[env] ⚠️  找不到 .env，依賴環境變數" -ForegroundColor Yellow
}

# ── 檢查 TELEGRAM_BOT_TOKEN ──
if (-not $env:TELEGRAM_BOT_TOKEN) {
  Write-Host "[ERROR] ❌ TELEGRAM_BOT_TOKEN 未設定" -ForegroundColor Red
  Write-Host ""
  Write-Host "  1. 前往 https://t.me/BotFather 建立 Bot"
  Write-Host "  2. 在 .env 中加入："
  Write-Host "     TELEGRAM_BOT_TOKEN=你的_TOKEN"
  Write-Host ""
  Pop-Location
  exit 1
}

# ── 檢查 Bun ──
$bun = if (Get-Command bun -ErrorAction SilentlyContinue) {
  (Get-Command bun).Source
} elseif (Get-Command bun.exe -ErrorAction SilentlyContinue) {
  (Get-Command bun.exe).Source
} else {
  "$env:USERPROFILE\.bun\bin\bun.exe"
}

if (-not (Test-Path $bun)) {
  Write-Host "[ERROR] ❌ Bun 未安裝或找不到" -ForegroundColor Red
  Write-Host "  安裝: irm bun.sh/install.ps1 | iex"
  Write-Host ""
  Pop-Location
  exit 1
}

Write-Host "[bun] $(bun --version)  at $bun" -ForegroundColor Green
Write-Host ""

# ── 啟動 ──
Write-Host "[start] 🚀 啟動 Telegram Memory Bridge..." -ForegroundColor Cyan
Write-Host ""

try {
  # PS5 相容：用 & 呼叫，不能用 ; 或 &&
  & $bun run src/index.ts
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "[ERROR] $_" -ForegroundColor Red
  $exitCode = 1
} finally {
  Pop-Location
}

if ($exitCode -ne 0 -and $exitCode -ne $null) {
  Write-Host "[exit] 結束碼: $exitCode" -ForegroundColor Yellow
  Write-Host "按任意鍵離開..."
  $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

exit $exitCode
