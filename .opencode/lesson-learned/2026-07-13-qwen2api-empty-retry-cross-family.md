# 2026-07-13 qwen2api 空內容重試跨家族修復

## 主因

空內容重試只重試「同家族」模型（如 `qwen3.6-plus` → `qwen3.6-plus-thinking`），
WAF 全域阻擋時同家族集體失敗，連續 2 次即判定全域放棄，從未嘗試 max/27b/coder 等不同家族。

更深層問題：`config/models.js` 設計的 `emptyAction` 欄位（指揮空內容時的修復策略：
`enable_thinking` / `retry_thinking` / `switch_model` / `skip`）**從未被 chat-proxy 消費**，
認知系統未完善串接。

## 症狀

對話中模型回傳空白 → proxy 跳重試 → 同家族候選全失敗 → 輸出
「上游模型 Qwen3.6-Plus 傳回空白，所有備用模型皆無回應」→ 對話框停滯。

## 修復（10 項，檔案：qwen2api-plugin/src/chat-proxy.js + config/model-cognition.js）

1. 新增 `_modelFamily()` 家族識別（max/plus/coder/small/qwq/37/other）
2. 空內容重試消費 `emptyAction` 策略（日誌：`空內容策略 (qwen3.6-plus): retry_thinking`）
3. **核心**：注入跨家族候選（max/coder/small/plus/qwq），根治同家族集體失敗
4. 截斷候選時保留跨家族優先權（避免被 `MAX_RETRY_CANDIDATES=5` 截掉）
5. 早退邏輯改為「家族感知」：同家族連續 2 次失敗才放棄，跨家族失敗繼續嘗試
6. 路由時依 `emptyAction=enable_thinking` 強制啟用 thinking（降低空內容率 ~21%→低）
7. `analyzeStall` 的 `switchModel` 映射修正為跨家族（coder→coder家族、thinking→plus-thinking家族）
8. 認知提示（promptHint）注入擴展至純聊天模式（原僅 tools 模式）
9. `analyzeStall` 空內容弱點匹配擴充（plus 家族 `stall-on-empty` 也觸發跨家族切換建議）
10. 路由日誌加入 `getCognitionSummary` 認知摘要，提升可觀測性

## 驗證

實測 `qwen3.6-plus` 被 WAF 阻擋（空內容）時：

```
📡 跨家族候選已注入: qwen3.6-max-preview, qwen3.6-27b-thinking
📡 空內容重試: qwen3.6-plus → 跨家族(max) qwen3.6-max-preview
📡 空內容重試: qwen3.6-plus → 跨家族(small) qwen3.6-27b-thinking
✅ 跨家族(small)重試成功 (qwen3.6-27b-thinking)
```

對話未中斷，不再出現「所有備用模型皆無回應」。

## 不變邊界（未觸動）

- `start.mjs` 鎖定區塊
- `chrome-fetch.js` headless:false
- `buildErrorResponse` content 鍵規則
- 斷路器禁用後階梯式恢復邏輯

## 關聯

- ARCHITECTURE.md → 對話中斷四層根因（層 1 WAF 空內容）
- 前次修復：2026-07-09 三主因（timer is not defined / DashScope 額度 / 路徑推斷）
- 測試環境：手動 `setsid bun src/start-proxy.js` 啟動（bash tool session 會回收背景進程，
  需用 setsid+disown 或 start.mjs 統一管理）
