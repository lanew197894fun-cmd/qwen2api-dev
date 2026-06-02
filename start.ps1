#Requires -Version 5.0
<#
.SYNOPSIS
  一鍵啟動 qwen2api-dev 全部服務（可選單一）
.DESCRIPTION
  可獨立啟動 qwen2api、chat-proxy、telegram-bridge
  或一鍵啟動全部
.EXAMPLE
  .\start.ps1            # 全部啟動
  .\start.ps1 -Core      # 只啟核心
  .\start.ps1 -Proxy     # 只啟代理
  .\start.ps1 -Telegram  # 只啟電報
#>

param(
  [switch]$Core,
  [switch]$Proxy,
  [switch]$Telegram
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# == 沒有指定參數 = 全部啟動 ==
$runAll = -not ($Core -or $Proxy -or $Telegram)

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   qwen2api-dev  一鍵啟動                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── helpers ──
function Find-Bun {
  $paths = @(
    (Get-Command "bun" -ErrorAction SilentlyContinue).Source,
    (Get-Command "bun.exe" -ErrorAction SilentlyContinue).Source,
    "$env:USERPROFILE\.bun\bin\bun.exe"
  )
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  return "bun.exe"
}

function Start-ServiceWin {
  param($Name, $Dir, $Cmd, $Title)
  Push-Location $Dir
  $logDir = Join-Path $scriptDir "logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $logFile = Join-Path $logDir "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$Name.log"
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c title $Title && $Cmd > `"$logFile`" 2>&1" -NoNewWindow -PassThru
  Pop-Location
  Write-Host "  ✅ $Name (PID: $($proc.Id))  日志: $logFile" -ForegroundColor Green
  return $proc
}

$BUN = Find-Bun
Write-Host "[bun] $BUN $(bun --version)" -ForegroundColor Green
Write-Host ""

$procs = @()

# ── 載入 .env 取 TELEGRAM_BOT_TOKEN ──
$envFile = Join-Path $scriptDir ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#=]+)=(.+)\s*$") {
      Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim() -ErrorAction SilentlyContinue
    }
  }
}

# ── qwen2api 核心 (port 3000) ──
if ($runAll -or $Core) {
  Write-Host "[1/3] Qwen2API 核心..." -ForegroundColor Yellow
  $qwenDir = Join-Path $scriptDir "qwen2api"
  Push-Location $qwenDir
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c title qwen2api-core && bun src/start.js --force" -WindowStyle Hidden -PassThru
  Pop-Location
  Write-Host "  ✅ qwen2api (PID: $($proc.Id))" -ForegroundColor Green
  $procs += $proc
  Start-Sleep -Seconds 2
}

# ── chat-proxy (port 3456) ──
if ($runAll -or $Proxy) {
  Write-Host "[2/3] Chat Proxy..." -ForegroundColor Yellow
  $proxyDir = Join-Path $scriptDir "qwen2api-plugin"
  Push-Location $proxyDir
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c title qwen2api-chat-proxy && bun src/start-proxy.js" -WindowStyle Hidden -PassThru
  Pop-Location
  Write-Host "  ✅ chat-proxy (PID: $($proc.Id))" -ForegroundColor Green
  $procs += $proc
  Start-Sleep -Seconds 1
}

# ── telegram-bridge (port 4377) ──
if (($runAll -or $Telegram) -and $env:TELEGRAM_BOT_TOKEN) {
  Write-Host "[3/3] Telegram Bridge..." -ForegroundColor Yellow
  $tgDir = Join-Path $scriptDir "telegram-memory-bridge"
  Push-Location $tgDir
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c title telegram-bridge && bun run src/index.ts" -WindowStyle Hidden -PassThru
  Pop-Location
  Write-Host "  ✅ telegram-bridge (PID: $($proc.Id))" -ForegroundColor Green
  $procs += $proc
} elseif ($Telegram -and -not $env:TELEGRAM_BOT_TOKEN) {
  Write-Host "  ⚠️  TELEGRAM_BOT_TOKEN 未設定，跳過" -ForegroundColor Yellow
}

Write-Host ""
if ($runAll) {
  Write-Host "══════════ 全部已啟動 ══════════" -ForegroundColor Cyan
  Write-Host "  qwen2api:     http://127.0.0.1:3000" -ForegroundColor White
  Write-Host "  chat-proxy:   http://127.0.0.1:3456" -ForegroundColor White
  if ($env:TELEGRAM_BOT_TOKEN) {
    Write-Host "  telegram:     port 4377" -ForegroundColor White
  }
  Write-Host "────────────────────────────────" -ForegroundColor Cyan
}
Write-Host "按任意鍵離開（服務繼續在背景運行）..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
