# Telegram Bridge 健康報告修復測試

## 問題描述
電報機器人 `/health` 指令在 Windows Master 端無法正確顯示「磁碟使用率」與「網路延遲」。
原因是 `api.ts` 中的 PowerShell 指令字串轉義錯誤，導致執行失敗。

## 修復步驟 (需於 Windows Master 端執行)

### 1. 驗證 PowerShell 指令格式
請開啟 **Windows PowerShell** 並執行以下兩行，確認輸出為數字：
