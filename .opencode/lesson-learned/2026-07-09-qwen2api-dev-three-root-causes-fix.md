# 2026-07-09 qwen2api-dev 三大主因修復

## 問題描述

用戶回報千問模型在 qwen2api-dev 環境中：

1. 本地發現未出現（記憶/知識庫未載入）
2. 模型思考過程有開啟但無顯示
3. 對話/建立文件時忽然停止、停滯沒執行

## 根因分析

### 主因 1：記憶表路徑錯誤（本地發現失效）

- `qwen2api-plugin/src/memory-bridge.js` 指向 `~/.openclaw/memory/lancedb-pro`
- 該目錄僅含空 `__manifest`（無 `memories` 表）
- 真實資料在 `projects/.opencode/memory/lancedb-pro/memories.lance`
- 導致日誌「🧠 記憶表不存在，跳過」、本地發現功能完全失效

### 主因 2：OUTPUT_THINK 設定衝突（思考過程不顯示）

- 根 `.env` 設 `OUTPUT_THINK=true`（2026-07-08 開啟思考鏈）
- 但 `qwen2api/.env` 設 `OUTPUT_THINK=false`（覆蓋）
- qwen2api 啟動時 `dotenv.config()` 無參數，預設載入 `qwen2api/.env`（cwd）
- 導致上游不輸出 `reasoning_content` 欄位

### 主因 3：passthrough 路徑無降級（停滯）

- 純聊天（無工具）走 passthrough 直通路徑
- 上游回空/錯誤時直接送 `[DONE]` 結束，無重試、無降級
- 上游 chat.qwen.ai 透過 Chrome 間歇性回空內容（createChat evaluate 逾時 20s）
- 對話框直接卡在「工作中」或空白

### 附加問題：start-proxy.js 未載入根 .env

- `AUTH_DISABLED` 未生效，間歇性要求 API Key
- 導致 curl 無 key 時 `Unauthorized: Invalid API Key`

## 修復內容

### Fix 1：memory-bridge.js 路徑修正

- 改為候選路徑掃描：優先 `projects/.opencode/memory/lancedb-pro`，其次舊路徑
- 取第一個含 `memories.lance` 表的路徑
- 支援環境變數 `MEMORY_DB_PATH` 覆寫

### Fix 2：qwen2api/.env OUTPUT_THINK=true

- 與根設定一致，啟用思考鏈輸出

### Fix 3：passthrough 失敗降級緩衝路徑

- `runSinglePass` 加 `forceBuffered` 參數跳過 passthrough 判斷
- 上游 HTTP 錯誤 → 降級 `runSinglePass(..., true)` 走完整空內容重試
- 上游 SSE 卡死且零輸出 → 降級 `runSinglePass(..., true)`

### Fix 4：start-proxy.js 載入根 .env

- 手動解析根 `.env`（避免 dotenv 依賴缺失）
- 僅填充未設定的變數，不覆蓋現有

## 驗證結果

- ✅ 記憶橋接就緒：3 筆記憶已載入（原「記憶表不存在，跳過」）
- ✅ reasoning_content 欄位啟用（複雜任務會有思考過程）
- ✅ 8/8 穩定性測試通過（帶 key 模擬 opencode）
- ⚠️ 上游 Chrome 路徑間歇性不穩定（createChat 逾時 20s），環境層問題待後續修復

## 待修復（環境層）

- ~~DashScope API Key 全部 403（無權限），只能走 chat.qwen.ai~~ → **已解決 (Fix 35)**
- ~~chat.qwen.ai WAF 偶發阻擋 axios 建立 chat_id，導致上游回空~~ → **已緩解（WAF 路徑保留為備用）**
- 需更穩定的 WAF 繞過或修復 DashScope key 權限

## Fix 35（2026-07-09 補充）：DashScope 額度耗盡導致對話忽然停止

### 問題

用戶回報「模型對話中/工作中會忽然停止，建立檔案或程式碼會停滯沒執行」。
實測發現：`qwen-max` 金鑰有效且繞過 WAF 穩定，但 `qwen-plus`/`qwen-flash` 免費額度耗盡
（`insufficient_quota` 403）。原 `_dsUnavailableModels` 為**永久 Set**，一旦 plus/flash 403
就永久封鎖；且 DashScope 路徑優先於 WAF 路徑 → 整條鏈失效 → 降級 WAF 又遇阻擋 →
對話忽然停止 / 工作中停止。表現為 proxy 回 `上游模型 Qwen3.6-Max-Preview 傳回空白，所有備用模型皆無回應`。

### 根因

1. `_dsUnavailableModels: Set` 永久封鎖，額度耗盡(暫時)被誤判為永久不可用
2. `tryModels` 雙向掃描未優先 `qwen-max`，plus/flash 耗盡後才試 max，浪費 round-trip

### 修復

1. `_dsUnavailableModels` 改為帶 TTL(5min) 的 Map，額度恢復後自動重試
2. `tryModels` 掃描順序：target 非 max 時將 `qwen-max` 提至第一優先
3. 任何層級(plus/flash/small/medium)請求都會自動提升到可用的 `qwen-max`

### 驗證

- ✅ 重啟 qwen2api 後，模擬「建立檔案」請求不再回空白錯誤，正確產生 tool_calls
- ✅ DashScope `qwen-max` 直連回應正常（繞過 WAF）
- ✅ 程式轉換邏輯（bash/heredoc/非 bash 區塊/裸文字）均已正常

### 關鍵原則

- 額度耗盡是**暫時性**錯誤，不可用永久 Set 封鎖——必須 TTL 自動恢復
- 當高階模型可用時，低階額度耗盡應**自動升級**而非放棄整條路徑
- 診斷「對話停止」類問題：先看 DashScope 各層級直連回應，確認哪層額度耗盡
