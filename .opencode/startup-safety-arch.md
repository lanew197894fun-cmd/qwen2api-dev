# qwen2api-dev 一鍵啟動安全架構

> ⚠️ **絕對死律：禁止修改啟動安全機制、殺行程邏輯，除非明確了解全部影響**

## 核心安全原則

所有殺行程操作必須通過 **歸屬驗證**，只殺本專案行程，絕不碰外部行程。

## 安全鏈（kill 路徑分層）

```
kill 請求
  │
  ├─ 層級1: cluster manifest ── 只含本專案 PID（明確定義）
  ├─ 層級2: children Map ────── launchService() 記錄的記憶體 PID
  ├─ 層級3: PID 檔案 ────────── /tmp/qwen2api-dev.pid（舊啟動器）
  └─ 層級4: forceKillPort() ── 埠口掃描 → isOurProcess() 驗證
                                  ├─ cluster manifest 比對
                                  ├─ /proc/PID/cwd 工作目錄比對
                                  ├─ /proc/PID/cmdline 關鍵字比對
                                  └─ ppid 父子關係比對
```

**層級 1-3 不須驗證（資料本身就只含本專案）。**
**層級 4 是唯一用埠口猜行程的，必須過 `isOurProcess()`。**

## 被修改過的檔案（2026-07-06）

| 檔案                               | 修改內容                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| `start.mjs` `forceKillPort()`      | 加入 `isOurProcess()` 過濾，非本專案跳過+警告                 |
| `start.mjs` `killOldGeneration()`  | 埠口清理改呼叫 `forceKillPort()`，二次殘留也過 `isOurProcess` |
| `stop-desktop.bat`                 | 移除 `tasklist \| findstr "bun"` 全殺改為 PID 檔案優先        |
| `start-qwen2api.bat`               | 移除 `tasklist \| findstr "bun"` 全殺改為埠口範圍清理         |
| `start-tmux.sh` `kill_orphans()`   | 從寬鬆 `grep` 改為 `case "$cwd"` 精確目錄比對                 |
| `start-desktop.ps1` `Cleanup-Port` | 加入 `Win32_Process.CommandLine` 驗證本專案                   |
| `start.mjs` 啟動界面               | 加入 `knowledge-wiki` 目錄完整性檢查（無埠口，顯示 ✅/⚠️/❌） |

## 服務依賴關係

```
telegram-bridge (port 4377)
  └─ import { FileProvider } from "../../knowledge-wiki-plugin/src/provider/file-provider"
      └─ 提供 knowledge/wiki/lesson 儲存與檢索（Telegram Bot 的知識工具）
```

`knowledge-wiki-plugin` 本身**無獨立埠口**，是 `telegram-bridge` 的程式碼依賴（直接 import FileProvider）。
啟動器檢查其 `dist/index.js` 及 `node_modules` 完整性，但**不啟動獨立服務**。

## 啟動界面輸出範例

```
[start] 🟢 **健康報告**: 100% | qwen2api:✅(12ms) chat-proxy:✅(8ms) telegram:✅(15ms)
[start] ──────────────────────────────────────
[start]   qwen2api:         http://127.0.0.1:3000
[start]   chat-proxy:       http://127.0.0.1:3456
[start]   telegram:         http://127.0.0.1:4377
[start]   knowledge-wiki:   ✅  /.../knowledge-wiki-plugin
[start] ──────────────────────────────────────
```

⚠️ **禁止修改啟動界面的顯示格式**（使用者要求保留此設計，避免每次改動都在問架構）

## 故障排查：懷疑誤殺

```bash
# 1. 查關機日誌（最近 20 筆）
bun start.mjs --log

# 2. 查 cluster 清單（記錄所有本專案子行程）
cat /tmp/qwen2api-dev-cluster.json

# 3. 手動確認埠口誰在用
lsof -ti :3000 -sTCP:LISTEN
lsof -ti :3456 -sTCP:LISTEN
lsof -ti :4377 -sTCP:LISTEN

# 4. 查看 raw 關機事件
cat ~/.opencode/qwen2api-shutdown.jsonl
```

## 不要做的事（🚫 禁止清單）

- ❌ `tasklist | findstr "bun"` → taskkill → **屠殺全部 bun 進程**
- ❌ `pkill -f "bun"` → **同左**
- ❌ `fuser -k 3000/tcp` 無 `isOurProcess` 過濾
- ❌ `lsof -ti :3000` 抓到 PID 就直接 kill
- ❌ 在 `stopServices()` / `cleanup()` / watchdog 中跳過 `forceKillPort()` 直接 `process.kill()` 埠口上的所有 PID

## 啟動器檔案

| 啟動器               | 平台        | 說明                          |
| -------------------- | ----------- | ----------------------------- |
| `bun start.mjs`      | Linux/macOS | 主啟動器，完整安全鏈 + 看門狗 |
| `start.sh`           | Linux       | shell wrapper，呼叫 start.mjs |
| `start-tmux.sh`      | Linux       | tmux 模式，獨立 session       |
| `start-qwen2api.bat` | Windows     | 批次檔模式 + 看門狗           |
| `start-desktop.ps1`  | Windows     | 主力機 PowerShell             |
| `stop-desktop.bat`   | Windows     | 停止腳本                      |
