# 經驗：qwen2api-dev 一鍵啟動誤殺外部行程修復

## 問題

start.mjs 的 `forceKillPort()` 無差別殺死埠口上所有行程，從不驗證是否為本專案。Windows 腳本 `tasklist | findstr "bun"` 屠殺系統上全部 bun 進程。

## 主因

`forceKillPort()` 內部已有完善的 `isOurProcess()` 驗證函數（4層檢查），但從未呼叫它。同樣的模式也發生在 `start-qwen2api.bat`（直接掃全部 bun.exe）和 `stop-desktop.bat`。

## 修復方案

1. `forceKillPort()` 加入 `pids.filter(p => isOurProcess(p))` 過濾，非本專案跳過+警告
2. `killOldGeneration()` 埠口清理改呼叫安全的 `forceKillPort()`
3. Windows `.bat` 移除 `tasklist | findstr "bun"` → taskkill 全部
4. `start-tmux.sh` 從字串 `grep` 改為 `case "$cwd"` 精確比對

## 關鍵教訓

- 殺行程的每一條路徑都必須通過歸屬驗證
- cluster manifest（明確定義哪些 PID 屬於我們）是最精準的方式
- 埠口掃描是不得已的最後手段，必須搭配 isOurProcess()
- Windows 的 netstat/tasklist 組合尤其危險，極易傷及無辜

## 知識庫插件定位

- `knowledge-wiki-plugin` **無獨立服務埠口**，是 `telegram-bridge` 的程式碼依賴
- `telegram-bridge/src/knowledge-tools.ts` 直接 `import { FileProvider } from "../../knowledge-wiki-plugin/src/provider/file-provider"`
- 啟動器顯示 `knowledge-wiki` 狀態時是檢查目錄完整性（dist + node_modules），非健康檢查

## 相關檔案

- `.opencode/startup-safety-arch.md` 完整架構參考
