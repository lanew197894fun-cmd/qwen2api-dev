# qwen2api-dev 滯留訊息修復手冊

> **用途**：對話框出現「卡住」、「轉圈圈」、「assistant 永不完成」時的快速診斷與修復
> **版本**：2026-06-30
> **相關教訓**：`lesson/2026-06-30-session-stderr-sanitization.md`｜**維基**：`Qwen2API-開發機輕量化與錯誤隔離`

---

## 快速診斷流程

```
對話框出現滯留訊息
      │
      ▼
[Step 1] 檢查服務是否活著
      │
      ├─ bun start.mjs                          ← 全部啟動
      ├─ curl -s http://127.0.0.1:3000/health   ← qwen2api
      ├─ curl -s http://127.0.0.1:3456/health   ← chat-proxy
      └─ 結果?
           ├── 全部 ✅ → 往下 Step 2
           ├── qwen2api 掛了 → 看 §A
           └── proxy 掛了  → 看 §B
      │
      ▼
[Step 2] 檢查終端機 stderr 有無錯誤
      │
      ├── [provider] ECONNREFUSED       → qwen2api 沒跑 → 看 §A
      ├── [proxy] upstream unreachable   → qwen2api 沒跑 → 看 §A
      ├── [proxy] 上游回傳空內容         → 模型降級異常  → 看 §C
      ├── [session] ❌ Agent not found   → 配置錯誤    → 看 §D
      └── 無任何錯誤輸出                 → 無限迴圈    → 看 §E
```

---

## §A. qwen2api 未執行 / 連不上

### 症狀

- 終端機：`[provider] connect ECONNREFUSED 127.0.0.1:3000`（重試 5 次後停止）
- 對話框：無錯誤訊息（已修復不進對話框）
- `curl :3000/health`：無回應

### 修復

```bash
# 1. 確認 3000 埠狀態
lsof -i :3000

# 2a. 沒在跑 → 啟動
cd ~/opencode-manager/projects/independent/qwen2api-dev
./start.sh

# 2b. 或是已經有舊程序卡住
kill -9 $(lsof -ti :3000) && ./start.sh

# 3. 確認啟動完成
curl -s http://127.0.0.1:3000/health | head -c 200
curl -s http://127.0.0.1:3456/health | head -c 200
```

### 歷史教訓

| 原因               | 詳情                                         |
| ------------------ | -------------------------------------------- |
| node 找不到（nvm） | spawn("node") ENOENT → 改用完整路徑          |
| 埠被佔用           | `start.mjs` 已修復不誤殺，但手動啟動需先清埠 |
| 記憶體不足         | 檢查 `free -h`，qwen2api 需至少 512MB        |

---

## §B. chat-proxy 未執行 / 掛掉

### 症狀

- 終端機：`[proxy] Upstream error` 或 `[proxy] ❌ Port 3456 已被佔用`
- `curl :3456/health`：無回應
- opencode TUI 顯示「連線中...」卡住

### 修復

```bash
# 1. 確認 proxy 狀態
lsof -i :3456
curl -s http://127.0.0.1:3456/health

# 2. proxy 已死 → 重啟（start.mjs 會自動處理）
#    或是手動：
cd qwen2api-plugin
bun src/start-proxy.js

# 3. 看 proxy 自己的錯誤日誌
cat logs/run-*/chat-proxy.log | tail -50
cat logs/run-*/chat-proxy.err | tail -50
```

### 歷史教訓

| 原因                   | 詳情                                   |
| ---------------------- | -------------------------------------- |
| uncaughtException 致死 | 已修復：改為 keepalive 存活            |
| 啟動重試 3 次仍失敗    | 印出指引訊息，程序保持存活，不強制離開 |
| EPIPE（parent 已死）   | 靜默吞錯，不噴錯誤                     |

---

## §C. 上游回傳空內容（WAF 阻擋 / 模型降級問題）

### 症狀

- 終端機：`[proxy] ⚠️ 上游回傳空內容 (model=qwen3.7-max)，嘗試降級重試`
- 對話框：模型回答空白或只有「正在思考...」
- 若 WAF 全域阻擋：連續空內容重試 timeout 自動縮短（5s→2.5s→1.5s）
- DashScope 降級（有 key 時）：`[Chrome Fetch] 連續 WAF 阻擋觸發 DashScope 自動降級`

### 修復

```bash
# 0. 🔥 根本解：設定 DASHSCOPE_API_KEY 繞過 WAF（強烈建議）
#    當連續 3 次請求都被 WAF 阻擋時，request.js 自動切換至 DashScope API
export DASHSCOPE_API_KEY="sk-xxx"
export DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# 1. 檢查 qwen2api 可用模型
curl -s http://127.0.0.1:3000/v1/models | python3 -m json.tool | grep '"id"'

# 2. 手動指定模型測試（指定單一模型跳過重試循環）
curl -s -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-qwen2api-test-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-27b","messages":[{"role":"user","content":"hi"}]}' | head -c 500

# 3. 強制指定路由模型
export PROXY_MEDIUM_MODEL=qwen3.6-27b
export PROXY_LARGE_MODEL=qwen3.7-plus
bun start.mjs
```

### 注意

- proxy 已有自動降級機制（large→medium→small），空內容重試 timeout 風暴感知
- **v5 新增**：連續空內容風暴抑制（5s→2.5s→1.5s 動態縮短）+ DashScope 自動降級
- **v5 新增**：Chrome 斷路器階梯式恢復（2min/3min/1min），不再鎖死 5 分鐘
- 錯誤永遠 `content:""` 不進對話框（僅 terminal 可見）

---

## §D. 配置錯誤（Agent / Model not found）

### 症狀

- 終端機：`[session] ❌ Agent not found: "xxx"`
- 對話框：顯示錯誤訊息（配置錯誤應顯示，正常）

### 修復

```bash
# agent 列表
grep -r "name:" ~/.opencode/config.json | grep agent

# model 列表
curl -s http://127.0.0.1:3456/v1/models | python3 -m json.tool | grep '"id"'
```

---

## §E. 無限迴圈 / 永不完成（最嚴重）

### 症狀

- 對話框：assistant 訊息卡住，**永不**完成
- 終端機：**完全無輸出**（沒有錯誤、沒有重試訊息）
- 請求永遠不結束

### 根因

`processor.ts` 的 catch 區塊中若使用 `continue` 而非 `return "stop"`，
會跳回 `while(true)` 頂部重新 `LLM.stream()` → 再次失敗 → 無限迴圈。

### 修復

```bash
# 1. 先確認是哪個檔案需要修
grep "continue" src/session/processor.ts | grep "MAX_RETRIES"

# 2. 看目前的邏輯
#    正確應是：attempt > MAX_RETRIES → return "stop"
#    錯誤是：  attempt > MAX_RETRIES → continue

# 3. 緊急解法：重啟 opencode
pkill -f "opencode" && bun run dev
```

### 檢查點

- `processor.ts` catch 區塊：max retries 後應 `return "stop"` + `Session.updateMessage`
- `filterCompacted`：壓縮邊界後應 `break` 而非 `continue`
- `start-proxy.js`：錯誤後不 `process.exit()`，應 keepalive

---

## §G. 背景駐留中斷 / 關閉時對話滯留（2026-07-06 修復）

### 症狀

- 背景執行 proxy 後，一段時間後對話框送出訊息無回應
- 或 proxy 關閉/重啟時，正在進行的對話卡住永遠不完成
- `ps aux | grep start-proxy` 找不到程序

### 根因

有三層問題疊加導致：

| 層  | 根因                                      | 位置                 | 說明                                                                                                                   |
| --- | ----------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | SIGHUP 背景殺死                           | `start-proxy.js`     | 背景執行（`setsid`）時終端機關閉送 SIGHUP → `shutdown()` → `server.closeAllConnections()` 強殺 SSE 串流，不送 `[DONE]` |
| 2   | 無 keepalive                              | `start-proxy.js:51`  | 程式設計為「不背景常駐」，HTTP server 空閒時可能被 GC/OS 回收                                                          |
| 3   | `buildErrorResponse` 回傳 `content: null` | `chat-proxy.js:1671` | 錯誤發生時對話框顯示空白，使用者誤以為「卡住」                                                                         |

### 修復內容（2026-07-06）

```bash
# 檔案位置
cd qwen2api-plugin/src
```

| 檔案             | 變更                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `start-proxy.js` | 完整重寫：背景模式（無 TTY）忽略 SIGHUP + keepalive 駐留；優雅關閉先用 `drain()` 等活躍 SSE 完成再 `closeAllConnections`   |
| `chat-proxy.js`  | 新增 `_activeSSE` Set 追蹤活躍串流 + `drain()` / `drainAndClose()` 匯出；`buildErrorResponse` 回傳摘要而非 `content: null` |

### 驗證

```bash
# 確認 proxy 正確駐留
setsid bun src/start-proxy.js > /tmp/proxy.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:3456/health | grep proxy

# 測試優雅關閉（不送 SIGKILL）
kill -TERM $(lsof -ti :3456)
# 確認日誌中有「等待 N 個活躍 SSE 串流完成...」
tail -5 /tmp/proxy.log
```

### 注意事項

- 背景模式偵測使用 `!process.stdout.isTTY`：若 stdout 被重定向到檔案（`> /tmp/proxy.log`），自動進入背景模式
- keepalive timer `unref()`：不影響程序正常退出（關閉時自動清除）
- 前景模式仍保留 SIGHUP → 優雅關閉行為（終端機關閉時清理資源）

---

## §F. 快速重置（完整重啟）

```bash
# 殺光所有相關服務
kill -9 $(lsof -ti :3000) 2>/dev/null
kill -9 $(lsof -ti :3456) 2>/dev/null
kill -9 $(lsof -ti :4377) 2>/dev/null

# 清除 PID 檔
rm -f /tmp/qwen2api-dev.pid

# 啟動
cd ~/opencode-manager/projects/independent/qwen2api-dev
./start.sh

# 驗證
sleep 3
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3456/health

# 清除殘留日誌（可選）
rm -rf logs/run-*
```

---

## §Z. 滯留訊息修復簡易對照表

| 症狀                     | 終端機輸出              | 最可能原因                        | 修復                | 歷史教訓                      |
| ------------------------ | ----------------------- | --------------------------------- | ------------------- | ----------------------------- |
| assistant 卡住永不完成   | 無輸出                  | 無限迴圈 `continue`               | 改 `return "stop"`  | §E                            |
| assistant 卡住或輸出雜訊 | 大量 stderr 警告        | bash 錯誤未隔離                   | 過濾非致命 stderr   | lesson: bash-stderr-isolation |
| assistant 卡住或輸出雜訊 | 大量 stderr 警告        | bash 錯誤未隔離                   | 過濾非致命 stderr   | lesson: bash-stderr-isolation |
| assistant 卡住永不完成   | `ECONNREFUSED` 重試 x5  | qwen2api 沒跑                     | `./start.sh`        | §A                            |
| assistant 卡住永不完成   | `Upstream error`        | proxy 掛了                        | 重啟 proxy          | §B                            |
| 模型回答空白             | `上游回傳空內容`        | 模型名稱錯誤                      | 降級重試 / 指定模型 | §C                            |
| 模型卡住只說不做         | `停滯偵測，自動矯正中`  | Qwen 認知覺醒失敗                 | proxy 會自動矯正    | 教訓: stall                   |
| 對話框有錯誤訊息         | `Agent not found`       | 配置錯誤                          | 修 config           | §D                            |
| 對話不完整被截斷         | `process.exit`          | 強制退出                          | 改 `exitCode = 1`   | 教訓: force-exit              |
| 對話框無錯誤但服務連不上 | 完全無錯誤輸出          | provider 錯誤已隔離               | 實際 qwen2api 沒跑  | 2026-06-30 修復               |
| assistant 訊息滯留       | 無輸出（idle 狀態）     | processor.ts 未 return stop       | 加入 return "stop"  | 2026-06-30 修復               |
| 對話框空白或卡住         | 無輸出（content: null） | buildErrorResponse 隱藏錯誤       | 改為回傳摘要        | lesson: error-visibility-fix  |
| Chrome 累積記憶體爆炸    | 系統卡頓、OOM kill      | 孤兒 Chrome 進程                  | 重啟 start.sh 即可  | 教訓: chrome-orphan           |
| 背景 proxy 消失/無回應   | proxy 程序不存在        | SIGHUP 背景殺死 + 無 keepalive    | start-proxy.js §G   | 2026-07-06 修復               |
| 關閉 proxy 後對話卡住    | `closeAllConnections`   | shutdown 強殺 SSE 無 `[DONE]`     | drain() 優雅關閉    | 2026-07-06 修復               |
| 錯誤後對話框空白         | 終端機有 `[系統錯誤]`   | `buildErrorResponse content:null` | 改為回傳摘要        | 2026-07-06 修復               |

---

## 🆕 終端機色彩系統（2026-07-02 新增）

### 目的

解決關鍵錯誤（如 `[系統錯誤]`）在終端機大量輸出中被忽略的問題。

### 色彩對照

| 類型            | 顏色                   | 範例                                                       |
| --------------- | ---------------------- | ---------------------------------------------------------- |
| `[系統錯誤]`    | **粗體紅色** `#e06c75` | `[系統] [系統錯誤] 上游模型 qwen3.6-27b 傳回空白...`       |
| `[proxy] ERROR` | 紅色                   | `[proxy] ERROR 串流直通失敗: connection reset`             |
| `[proxy] WARN`  | 黃色                   | `[proxy] WARN 上游回傳空內容，嘗試降級重試`                |
| `[proxy] INFO`  | 青色                   | `[proxy] INFO Chat Proxy running on http://127.0.0.1:3456` |
| `[proxy] DEBUG` | 灰色                   | `[proxy] DEBUG 路徑正規化...`                              |
| 標籤            | 各模組專屬色           | proxy=藍、系統=灰、router=青、auth=綠、evolution=紫        |

### 環境變數控制

```bash
# 強制啟用色彩（CI/無 TTY 環境）
FORCE_COLOR=1 ./start.sh

# 強制禁用色彩
NO_COLOR=1 ./start.sh

# 調整日誌等級
PROXY_LOG_LEVEL=debug ./start.sh  # silent/error/warn/info/debug
```

### 故障排除時的色彩優勢

1. **錯誤即時可見**：紅色粗體 `[系統錯誤]` 在大量綠/青/黃輸出中極難被忽略
2. **模組快速識別**：標籤著色讓你一眼看出是哪個模組輸出
3. **等級分層**：DEBUG 灰色不干擾，ERROR 紅色優先關注

---

## 相關檔案一覽

| 檔案                                  | 功能                                  |
| ------------------------------------- | ------------------------------------- |
| `start.sh`                            | 啟動腳本（wrapper）                   |
| `start.mjs`                           | 啟動邏輯（埠管理、子進程、健康檢查）  |
| `qwen2api-plugin/src/start-proxy.js`  | Proxy 啟動（重試、keepalive）         |
| `qwen2api-plugin/src/chat-proxy.js`   | 請求路由、tool_calls、停滯偵測        |
| `qwen2api-plugin/src/color.js`        | 🆕 統一色彩系統核心模組               |
| `<opencode>/src/session/processor.ts` | LLM 串流處理、重試、錯誤路由          |
| `<opencode>/src/session/prompt.ts`    | Session 主迴圈、錯誤處理              |
| `AGENTS.md`                           | 專案規範（開發環境、不變邊界）        |
| `qwen2api/src/utils/chrome-fetch.js`  | Chrome Fetch Proxy（輕量化模式）      |
| `qwen2api/src/server.js`              | process.on("exit") 清理 Chrome 子進程 |
| `logs/run-*/`                         | 各服務日誌（啟動後產生）              |

---

> **最後手段**：如果上述都無法解決，執行 `bun start.mjs` 看完整 startup log，
> 錯誤訊息會彩色標示（紅=錯誤、黃=警告、青=資訊、灰=除錯）。
