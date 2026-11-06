# 2026-07-08 停滯與錯誤不可複製修復

## 問題

使用者回報：模型對話/工作中忽然停止、建立文件或程式碼會停滯不執行；錯誤訊息只顯示在終端機/控制台，對話框無法複製錯誤訊息。

## 根因（3 層共振）

1. **錯誤訊息不可複製**：`buildErrorResponse` 在 v6↔v7 反覆橫跳，v7 設 `content:""` 導致對話框空白、無法複製，使用者以為卡死。
2. **重試降級 postJSON 卡死 180s**：`requestUpstream` router 失敗後降級 `postJSON`，預設 `timeout=60000, retries=2` → 3×60s=180s 卡死，對話框長期「工作中」。
3. **Chrome 預熱失敗未觸發 WAF 模式**：`createChat 失敗` catch 未呼叫 `_cbRecordFail(true)`，WAF 模式未啟動，Chrome timeout 維持 10s 未加速。

## 修復（一次一變數）

- **Fix v8-1**：`buildErrorResponse` 回退 v6 行為，`content: "⚠️ {msg}"` 可複製 + terminal log（滿足使用者需求且不違反不變邊界 content key 保留）。
- **Fix v8-2**：`requestUpstream` 降級 `postJSON` 的 `retries` 改 0（router 已重試，不應再重試 180s）。
- **Fix v8-3**：`chrome-fetch.js` `createChat 失敗` catch 補 `_cbRecordFail(true)`，預熱失敗加速 WAF 模式降級。
- **Fix v8-4**：`SSE_IDLE_TIMEOUT_MS` 改動態函式 `_getSseIdleTimeout()`，WAF 風暴時 45s→8s，避免串流直通路徑對話框停滯。

## 驗證

- 錯誤路徑 1 秒內回傳 `⚠️` 可複製文字（原 180s 卡死）。
- 語法檢查通過，服務健康。

## 二度翻車防範（對照 main 原始碼）

- dev `request.js` 已大幅偏離 main（Chrome Fetch + WAF + DashScope），main 僅 axios+retry。
- 升級本源時需重新套用 dev 偏離點，勿直接覆蓋。
- `buildErrorResponse` 的 v6/v7 反覆橫跳是技術債，v8 定案為「可複製」方向。

## 相關檔案

- `qwen2api-plugin/src/chat-proxy.js`（buildErrorResponse, requestUpstream, SSE_IDLE_TIMEOUT）
- `qwen2api/src/utils/chrome-fetch.js`（createChat catch）
