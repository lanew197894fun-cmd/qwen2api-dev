# Telegram Bridge 健康報告修復指南

## 問題
Windows Master 端 /health 指令的「磁碟使用率」與「網路延遲」顯示為 0% 或 N/A。

## 驗證步驟 (於 Windows PowerShell 執行)

1. 測試磁碟使用率:
$d = Get-CimInstance Win32_LogicalDisk -Filter 'DeviceID="C:"'; [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100)

2. 測試網路延遲:
(Test-Connection -ComputerName 8.8.8.8 -Count 1).Latency

## 修復 api.ts

檔案路徑: src/api.ts

尋找 // Health 區塊中的 diskPct 與 pingMs 邏輯，替換為:

let diskPct = 0;
try {
  if (isWin) {
    const psCmd = '$d = Get-CimInstance Win32_LogicalDisk -Filter \'DeviceID="C:"\'; [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100)';
    const out = execSync("powershell -Command \"" + psCmd + "\"").toString().trim();
    diskPct = parseInt(out) || 0;
  } else {
    const df = execSync("df -h / | tail -1 | awk '{print $5}'").toString().trim().replace("%", "");
    diskPct = parseInt(df) || 0;
  }
} catch {}

let pingMs = -1;
try {
  if (isWin) {
    const psCmd = '(Test-Connection -ComputerName 8.8.8.8 -Count 1).Latency';
    const out = execSync("powershell -Command \"" + psCmd + "\"").toString().trim();
    pingMs = parseFloat(out) || -1;
  } else {
    const pingOut = execSync("ping -c 1 -W 2 8.8.8.8 2>/dev/null | grep time= | awk -F'time=' '{print $2}' | awk -F' ' '{print $1}'").toString().trim();
    pingMs = parseFloat(pingOut) || -1;
  }
} catch {}

## 重啟服務
結束 bun 進程後重新執行:
bun run src/index.ts

## 驗證
電報發送 /health，確認磁碟與延遲有數值。
