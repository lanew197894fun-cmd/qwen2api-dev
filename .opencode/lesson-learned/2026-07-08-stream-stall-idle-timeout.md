# 2026-07-08 串流直通停滯根治 + 錯誤訊息不滯留對話框

## 問題現象

模型在對話中/工作中忽然停止，建立檔案或程式碼會停滯沒執行，對話框永久顯示「工作中」。
錯誤訊息（如「上游模型傳回空白」）只顯示在終端機，但 v6 改的 `buildErrorResponse` 把
`⚠️ ${msg}` 塞進 content，導致錯誤文字滯留對話框且無法複製。

## 根因（雙重）

1. **串流直通 body 讀取無 idle 逾時（最關鍵）**
   - `postStream` 的 120s timeout 只在 `fetch` 等 headers 階段有效，headers 一到即 `clearTimeout`。
   - 之後 `reader.read()` 迴圈完全無 timeout。上游 Chrome SSE 被 WAF 阻擋
     （`Chrome SSE evaluate 逾時 20s` + `SSE 降級略過`）時，上游串流既不送資料也不關閉
     → `reader.read()` 永久阻塞 → 對話框永遠「工作中」→ tool_calls 永遠不送達 = 停滯。
2. **錯誤訊息滯留對話框**
   - v6 把錯誤塞進 content，違反使用者「錯誤只進終端機」需求。

## 修復（chat-proxy.js）

- **Fix v7-A**：新增 `readChunkWithIdleTimeout(reader, idleMs)` 輔助函式，對每個 chunk 讀取
  race 一個 idle timer（`SSE_IDLE_TIMEOUT_MS=45000`）。上游卡死即拋錯，passthrough 迴圈
  catch 後送 `data: [DONE]\n\n` 並 `safeEnd`，不阻塞對話框。
- **Fix v7-B**：`buildErrorResponse` 回退 v6，content 設為空字串 `""`（保留 key 不違反不變邊界
  `content:""` 必須保留），錯誤詳情僅 `log.sysError` 輸出終端機，對話框不滯留。

## 驗證

- 單元測試：模擬永不送資料的 reader，`readChunkWithIdleTimeout` 在 2s 內拋逾時 ✅
- 實測 stream 請求（無 tools）：10.8s 返回 `[DONE]` ✅
- 實測 stream 請求（含 tools，建立檔案場景）：16.5s 返回 `[DONE]` ✅
- 實測非 stream 錯誤回應：content=''（空字串，不滯留）✅

## 不變邊界確認

- `buildErrorResponse` content 保留 key（空字串），未省略 → 符合 `🔥 content:"" 必須保留 key`
- 未改 `start.mjs` LOCKED 區塊、未改 `chrome-fetch.js headless`、未 process.exit()
- 開發環境無真實金鑰：Chrome WAF 阻擋後 axios 降級路徑完全不可用，故空內容/逾時為預期行為，
  修復重點在「不阻塞」而非「強制成功」。

## 關聯

- 上游 SSE 卡死根因在 `chrome-fetch.js` 的 `SSE 降級略過`（WAF 阻擋時省 20s main page evaluate），
  此修復在 proxy 層兜底，確保即使上游卡死對話框也不會永久停滯。
