# 2026-07-08 Proxy 自行退出 + 埠不一致導致對話卡死

## 症狀

- 模型對話中或工作中「忽然停止」，建立檔案/程式碼會停滯沒執行
- 本地測試時未重現（本地請求頻繁，event loop 有活躍任務維持 proxy 存活）
- 實際使用一段時間後 proxy 消失，opencode 所有請求卡死

## 根因（3 項 + 插件自載機制）

### 1. Proxy 埠不一致（3456 vs 3457）— 最致命

- `start.mjs` 注入 `PROXY_PORT: "3457"` 給 proxy 子進程（L668），且健康檢查 URL 全用 3457
- 但 `config.json`、`.env`、`ARCHITECTURE.md`、TROUBLESHOOT.md、外部 opencode 插件配置全指向 **3456**
- 結果：proxy 跑在 3457，opencode 連 3456 → 連線拒絕 → **所有對話框全部卡死**
- 啟動報告印 `chat-proxy:✅(6ms)` 是偵錯 3457，誤導判斷

### 2. Proxy 自行退出 (code 0) — 核心穩定性缺陷

- `start-proxy.js` 僅「背景模式（無 TTY）」設 keepalive timer
- `start.mjs` 注入 `FOREGROUND: "true"` → proxy 走前景模式 → **無 keepalive**
- 前景模式 + stdout 被 pipe 到 log → event loop 無持續任務時 Bun 自行退出 (code 0)
- `start.mjs` 的 `launch()` 的 `proc.on("exit")` **只記錄日誌不重啟** → 3456 永久斷聽

### 3. 裸文字檔案寫入未轉 tool_calls — 建立檔案停滯

- 模型常輸出無 ```fence 的 `cat > file <<EOF`/`echo x > file` 裸文字
- `bashBlockToToolCalls` / `nonBashBlockToToolCalls` 只匹配 ```fence，裸文字失效
- 回傳純文字 `finish_reason: "stop"` → opencode 視為完成 → **檔案沒建立 → 停滯**

## 修復

| 檔案             | 變更                                                                                           | 說明                           |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `start.mjs`      | `PROXY_PORT` 改回 `"3456"`，健康 URL 改 3456，移除錯誤的 waf-proxy 引用                        | 統一埠，解決 opencode 連不上   |
| `start.mjs`      | `launch()` 的 `proc.on("exit")` 加 chat-proxy 自動重啟（3s，code≠0 時）                        | proxy 退出後自動恢復           |
| `start.mjs`      | `cleanup()` 設 `globalThis.__shuttingDown = true`                                              | 關閉時不重啟                   |
| `start-proxy.js` | **兩種模式都啟用 keepalive timer（ref 非 unref）**                                             | 防 event loop 空閒自行退出     |
| `chat-proxy.js`  | **`startProxy()` 內 listen 回調加 keepalive timer（ref，server close 時 clear）**              | 插件 autoStartProxy 呼叫也穩定 |
| `index.js`       | `startMonitor()` 發現 proxy down 時主動 `autoStartProxy()` 重啟                                | 監控自動恢復，不再只記 WARN    |
| `chat-proxy.js`  | 新增 `looseBlockToToolCalls()`：處理無 fence 的 heredoc/echo>/裸程式碼 → write/bash tool_calls | 解決建立檔案停滯               |
| `chat-proxy.js`  | `runSinglePass` 在 writeCalls 檢查後調用 `looseBlockToToolCalls`                               | 寬鬆 fallback 補救             |

## 驗證

- proxy 穩定存活 60s+（之前約 2 分鐘內自行退出）
- `curl 3456/health` 正常返回
- 裸文字 `cat > /tmp/x.js <<EOF` → 轉為 `tool_calls`（`finish_reason: tool_calls`）
- 3457 已無監聽

## 教訓

1. **埠號是分散管理的定時炸彈**：改埠必須同步所有引用點（start.mjs / config.json / .env / 外部配置 / 文檔），否則啟動報告說健康但實際連不上
2. **啟動報告偵錯的埠 ≠ 實際服務埠** 會嚴重誤導判斷
3. **被 pipe 的前景模式進程會自行退出**：凡常駐服務必須 keepalive，不能依賴 event loop 自然維持
4. **子進程退出必須有重啟機制**，否則單點故障導致全系統卡死
5. **模型輸出格式多變**：fence 不是必然，proxy 必須有寬鬆 fallback 才能保證工具呼叫不遺失
