# Qwen「上游無回應」根因修復 + 4377 孤兒埠重啟循環（2026-10-21）

## 症狀

1. opencode 免費層經 chat-proxy（3456）對話，尖峰時段大量顯示「上游無回應 / 所有 Provider 均失敗」。
2. `bun dev` 時 telegram-bridge 無限 EADDRINUSE（4377）重啟循環，全部失敗。

## 根因（兩獨立證據各自確認）

### A. 「上游無回應」≠ 網速問題，是 Qwen WAF 風控連鎖

- 證據 1：`docs/2026-10-18-chat-challenge-breaker.md` 記錄尖峰時段（台灣 15:00–06:00）上游回 503「被挤爆啦」chat challenge。
- 證據 2：proxy 遇 503 後 2 秒立即重試 → hammer 加劇 → 熔斷計數飆升 → failover 全數陣亡 → 使用者看到「所有 Provider 均失敗」。
- 即：**Qwen 服務端風控，非本機網速**。冷靜時段（凌晨）實測 648KB 大 ctx 僅 8.2s。

### B. 4377 EADDRINUSE 重啟循環 = start.mjs 清理清單漏埠

- 先前 nohup 手動啟動的 telegram-bridge（孤兒 `bun src/index.ts`）殘留佔住 0.0.0.0:4377。
- `start.mjs` 清理邏輯 `PORTS = [3000, 3456, 3457]` **漏了 4377**，啟動時永不掃描該埠 → 新實例必撞 EADDRINUSE → exit(1) → 「異常退出，3s 後自動重啟」無限循環。
- `killOurByPort`（含 `isOurProcess` cwd 精準過濾）本身正常，只是沒被呼叫到 4377。

## 修復

| # | 檔案 | 修復 |
|---|------|------|
| 1 | `qwen2api-plugin/src/provider/provider.js` | `_CHALLENGE_RE`/`_isChallenge`/`_retryAfterSec`/`_challengeErr`：503/403 chat challenge 快速失敗，不重試、不計熔斷；一般 5xx 重試尊重 Retry-After |
| 2 | `qwen2api-plugin/src/provider/router.js` | failover catch 到 `e.challenge` 即中止（同 IP 必敗，failover 無意義） |
| 3 | `qwen2api-plugin/src/chat-proxy.js` | 全域 `_challenge` 冷卻（retryAfter 秒）；冷卻期直接回「⏳ Qwen 上游風控中（尖峰時段自動保護），約 Ns 後恢復」；串流直通 503 跳過緩衝重試 |
| 4 | `qwen2api/src/utils/chat-helpers.js` | `thinking_budget` 欄位修正（原誤寫 `.budget` 上游不認識）；廢除 `Number(x) !== Number.NaN` 恆真式 |
| 5 | `telegram-memory-bridge/src/bot.ts` | `isTrivialChat` 重寫：問句（？/嗎/呢）與疑問詞前綴（為什麼/怎麼/幫我/請問）不得判閒聊；移除 `<5ch` 與「單字<10ch」過寬規則 |
| 6 | `start.mjs`（非鎖定區） | `PORTS` 兩處（啟動清理 L696、cleanup L472）補入 `4377`，孤兒 telegram-bridge 會被 `killOurByPort`（精準 PID 過濾）清理 |

## 驗證

- 語法：`bun build --target bun` 全數通過；challenge 偵測 3/3 樣本正確。
- 服務：`bun dev` 三服務健康（3000/3456/4377），telegram-bridge 僅單實例，EADDRINUSE 循環消除。
- 對話：proxy 非串流 32s 回覆正常；串流通；大 ctx 8.2s。

## 教訓

1. **重啟循環要先查「誰佔著埠」而非只看新實例日誌**：`ss -ltnp | grep PORT` 一秒定位孤兒 PID；再查啟動器清理清單是否涵蓋該埠。
2. **上游 503 分兩種**：暫時性（重試合理）與風控 challenge（重試= hammer，會把熔斷打滿）。偵測到 challenge 類字樣必須走「不重試 + 冷卻 + 友好提示」路徑。
3. **「無回應」類症狀先排除時段因素**：Qwen 尖峰（台灣 15:00–06:00）WAF 挑戰率極高，冷靜夜間對照實測才能分離網速 vs 風控。
4. **手動 nohup 啟動服務是孤兒來源**：除非必要，一律走 `bun dev`/`start.sh`，避免脫離 PID 檔管理。

## 未修追蹤（TODO）

- **思考內容洩漏進 content**：上游（chat.qwen.ai 免費層）把思考以純文字放 `content`，無 `<think>`/`reasoning_content` 標記，`qwen2api/src/controllers/chat.js` SSE parser 現階段無法區隔 → 對話開頭出現「Process:\n1. 分析輸出…」。需設計 heuristic（如首段匹配思考樣式後剥离）或等上游欄位。已確認非本批次修改引入。
- 思考等級調整：客户端傳 `thinking_budget`（low≈2048 / medium≈8192~16384 / high=81920），欄位已修復，尚未在 opencode config 層實際配置分層。

## 相關

- `projects/independent/qwen2api-dev/docs/2026-10-18-chat-challenge-breaker.md`（challenge 熔斷背景）
- `projects/independent/qwen2api-dev/ARCHITECTURE.md` → 修改追蹤 Fix 4x
