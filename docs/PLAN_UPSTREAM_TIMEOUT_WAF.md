# 上游長推理／WAF 風控防護計畫（M4）

> 建立：2026-11-01
> 範圍：**僅限本專案 `qwen2api-dev`**。禁止修改 `projects/system`（opencode 核心）。
> 目的：避免「推理時間過長 → 上游無回應」，並防止 WAF 熔斷期間無效重試與 `write after end`。

---

## 一、現象（2026-11-01 03:27 啟動日誌）

| 現象 | 日誌證據 |
| :--- | :--- |
| 上游無回應 | `❌ 流式資料處理錯誤` + `UpstreamResponseError` |
| WAF 風控 | `qwen2api stream chat challenge（風控）`、`strikes=1,3,5,7` |
| 熔斷開啟仍請求 | `⚠️ [WAF] 熔斷開啟中（剩 30s/60s），跳過免額請求` |
| 重複寫入 | `❌ 未捕獲異常: write after end` |
| Chrome 逾時降級 | `[Chrome Fetch] 逾時 (15s)，降級 axios` |

---

## 二、根因分析

### 主因 A：timeout 層級倒置（推理時間過長 → 上游無回應）

`qwen2api-plugin/src/config/index.js` laptop profile（L56-60）：

```
requestTimeoutMs : 60000    → CFG.REQUEST_TIMEOUT = 60s   （chat-proxy L3128 請求計時器）
chatTimeoutMs    : 60000    → CFG.CHAT_TIMEOUT
thinkingTimeoutMs: 120000   → CFG.THINKING_TIMEOUT = 120s （chat-proxy L2384 fetch 逾時）
```

`chat-proxy.js` 三個計時器實際順序：

```
REQ_TIMER 60s  <  FETCH 120s  <  IDLE 180s(預設)
```

**推理 > 60s 時，請求計時器先觸發 `ac.abort()` → fetch 中斷 → 回報「上游無回應」。**
`CHAT_IDLE_THINKING_MS` 的 180s 永遠碰不到，形同無效設定。

### 主因 B：WAF 熔斷期間仍重試

`qwen2api/src/utils/upstream-error.js`：`strikes >= 3` 開 60s 全域熔斷。
但 `chat-proxy.js` L2413-2464 降級直連在熔斷期間仍逐次請求 → 每次都被 challenge
→ `strikes` 持續累加（日誌 1→3→5→7），完全無冷卻效果。

### 主因 C：`write after end`

`chat-proxy.js` L3130-3151 請求計時器 `res.end()` 後：
- heartbeat（L2524）仍 `res.write(": heartbeat\n\n")`
- stream catch（L2751）仍 `res.write(...)`
未檢查 `res.writableEnded` / `res.destroyed`。

### 副因 D：錯誤格式非標準

L2723 回傳 `{"error":"字串","error_code":...}`，非 OpenAI 標準物件
→ 客戶端 union 驗證失敗（`Type validation failed`）。

---

## 三、修正計畫（分階段，一次一變數）

### 階段 1：修正 timeout 層級（解決「推理過長無回應」）

| 項目 | 目標值 | 位置 |
| :--- | :--- | :--- |
| `requestTimeoutMs`（laptop） | 300000（5 分） | `config/index.js` laptop profile |
| `thinkingTimeoutMs`（laptop） | 600000（10 分） | `config/index.js` laptop profile |
| `CHAT_IDLE_THINKING_MS` | 300000（5 分） | `.env`（新增） |

**硬性規則（寫入註解）：**

```
REQUEST_TIMEOUT >= THINKING_TIMEOUT > CHAT_IDLE_THINKING_MS
請求計時器必須是最後防線，不得早於 fetch 或 idle 逾時。
```

### 階段 2：WAF 熔斷期短路（避免 hammering）

- `chat-proxy.js` 降級直連前檢查熔斷狀態（透過 qwen2api 回應的 `retry_after_seconds` 或 `code=waf_breaker_open`）。
- 熔斷開啟時：直接回 `503 + Retry-After`，**不發任何上游請求**。
- 移除熔斷期的重試（`attempt < maxRetries` 時若 `e.challenge` 直接 throw）。

### 階段 3：`write after end` 防護

- 所有 `res.write()` 前加 `if (res.writableEnded || res.destroyed) return;`
- 位置：heartbeat L2524、stream catch L2751、空資料 L2723。

### 階段 4：標準化錯誤格式

- L2723 改為：
  ```json
  {"error":{"message":"上游無回應","type":"upstream_timeout","code":"upstream_timeout","retry_after_seconds":30}}
  ```

### 階段 5：免額優先策略（需用戶決策）

- 現況 `DASHSCOPE_ALLOW_FALLBACK=false`：免額失敗即回錯，不動用百煉（避免付費）。
- 選項 A：維持（純免額，WAF 期間只能等）。
- 選項 B：WAF 熔斷時短暫啟用百煉備援（需設定 `DASHSCOPE_API_KEY`）。
- **預設維持 A**，僅在計畫中記錄選項。

---

## 四、驗收標準

- [ ] 推理 90s 不再回「上游無回應」（請求計時器不再提前中斷）
- [ ] WAF 熔斷期間日誌不再出現連續 `strikes` 累加
- [ ] 日誌不再出現 `write after end`
- [ ] 客戶端不再出現 `Type validation failed`
- [ ] `bun dev` 啟動 + 一次真實對話驗證通過

---

## 五、邊界

- 本計畫所有修改僅限 `/home/reamaster/opencode-manager/projects/independent/qwen2api-dev/`。
- **禁止**寫入 `/home/reamaster/opencode-manager/projects/system/`（opencode 核心）。
- 修改前後依 AGENTS.md 記錄 lesson + CHANGELOG。
