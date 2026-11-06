# 一鍵啟動誤殺系統 + 斷路器滯留訊息修復

## 問題

### P1: 一鍵啟動重啟時誤殺系統進程

- `start.mjs` `forceKillPort()` 無差別殺所有佔用埠口 (3000/3456/4377) 的行程
- `killOldGeneration()` 層級 3 裸殺，註解寫「不需安全判斷」
- `isOurProcess()` 已定義但**從未被調用**
- `start-tmux.sh` `kill_orphans()` 也無差別屠殺

### P2: 斷路器開啟後每請求都噴 warn

- `qwen2api-plugin` 斷路器每跳過一個請求就 `log.warn("⚠️ 斷路器開啟，跳過請求")`
- `chrome-fetch.js` 斷路器每 tick 都 `logger.warn`
- 導致使用者在對話中看到大量重複警告

## 修復內容

| 檔案                                 | 改動摘要                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `start.mjs`                          | `forceKillPort()` 加入 `isOurProcess()` 過濾；`killOldGeneration()` 層級 3 改用 `forceKillPort()`                  |
| `start-tmux.sh`                      | `kill_orphans()` 加入 /proc/$pid/cwd 和 cmdline 比對，只殺本專案行程                                               |
| `qwen2api-plugin/src/index.js`       | 斷路器加入 `_warnedOpen`/`_warnedHalf` 狀態鎖；新增 `resetCircuitBreaker()` 並在 Plugin 入口呼叫；Monitor 靜默處理 |
| `qwen2api/src/utils/chrome-fetch.js` | 斷路器加入 `_warned` 鎖，只在首次打開時印一次                                                                      |

## 關鍵原則（經驗教訓）

1. **殺進程前先驗證歸屬** — 不要相信埠口掃描，要檢查 `/proc/$pid/cwd` 和 cmdline 或 cluster manifest
2. **斷路器訊息要 rate-limit** — `log.warn` 每請求噴一次 = 使用者看到的垃圾訊息，加狀態鎖只在狀態轉換時印
3. **定義了的函式要檢查是否真的被調用** — `isOurProcess()` 從未被呼叫就是有人改了 A 忘了改 B
