# 移植 Qwen chat challenge 熔斷機制（免額路線）

> 日期：2026-10-18 01:05
> 來源：Rfym21/Qwen2API commit `81b75ad`（2026-09-26）

## 背景

### 原作者實測數據（issue #180，2026-09-23~26 生產環境）

| 指標                     | 數值                     |
| ------------------------ | ------------------------ |
| 總 chat 請求             | 502 次                   |
| 被 challenge             | **477 次（95%）**        |
| 成功                     | 25 次（全在夜間 UTC）    |
| 挑戰時段                 | **全部在 07:00Z–22:00Z** |
| 同一帳戶                 | 白天被挑、夜間通過       |
| 建立 chat / 上傳 history | 挑戰前幾秒仍成功         |

**結論：不是帳戶問題、不是 context 大小問題，是 Qwen 白天尖峰的主動風控。**

> ⚠️ 我先前判斷「IP 被封鎖」不準確。作者的時段數據推翻該假設。
> 台灣時間 06:00–15:00（UTC 22:00–07:00）應可正常使用。

### Qwen 的 challenge 幀（HTTP 200，無 choices）

```json
{
  "ret": [
    "FAIL_SYS_USER_VALIDATE",
    "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"
  ],
  "data": { "url": ".../_____tmd_____/punish?x5secdata=...&action=captcha" }
}
```

本地舊版只認 HTTP 403/503 → 此幀被**靜默吞掉** → 對外表現為「上游空白」。

---

## 變更內容（2 檔）

### 1. 新增 `qwen2api/src/utils/upstream-error.js`（181 行）

MD5 `c18eb8a728d57017ee71c77198dc9fa4`

| 匯出                                 | 說明                                             |
| ------------------------------------ | ------------------------------------------------ |
| `assertNoUpstreamFailure(payload)`   | 偵測 challenge 幀並丟錯；有 `choices` 則重置熔斷 |
| `assertChatChallengeBreakerClosed()` | 熔斷開啟中直接丟錯（省 round-trip）              |
| `isWafChallengeError(error)`         | 判定是否 challenge                               |
| `chatBreakerState()`                 | 查詢熔斷狀態（日誌用）                           |
| `resetChatChallengeBreaker()`        | 手動重置（測試用）                               |

**常數**

```js
CHAT_CHALLENGE_RETRY_AFTER_SECONDS = 30;
CHAT_BREAKER_STRIKES = 3;
CHAT_BREAKER_SECONDS = 60;
```

**WAF_SIGNAL_RE** 特徵字串：

```
fail_sys_user_validate | rgv587 | 被挤爆 | captcha
| _____tmd_____ | punish? | action=captcha | x5secdata
```

**熔斷器**：單一全域（同進程所有帳戶共用同一出口 IP）

```js
const chatBreaker = { strikes: 0, openUntil: 0 };
```

### 2. 修改 `qwen2api/src/controllers/chat.js`

MD5 `0504360cb9ee4951e0fe8698ef2686b9`

| 位置     | 修改                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| L11-17   | 引入 `assertNoUpstreamFailure` / `isWafChallengeError` / `chatBreakerState`                    |
| L565-590 | SSE 分派處：解析每個 `data:` 幀，先 `assertNoUpstreamFailure`，challenge 則 `cleanup + reject` |
| L744-762 | catch 區：challenge → **503 + `Retry-After: 30`**，其餘維持 500                                |

**行為對比**

|                | 舊版                     | 新版                           |
| -------------- | ------------------------ | ------------------------------ |
| challenge 偵測 | ❌ 只認 403/503          | ✅ 解析 HTTP 200 內的 `ret` 幀 |
| 對外回應       | 空白 / 500 Service error | **503 + Retry-After: 30**      |
| 帳戶冷卻       | 無                       | **無**（challenge 與帳戶無關） |
| 連續挑戰       | 持續 hammer Qwen         | **3 次後熔斷 60 秒**           |

---

## 驗證

```bash
# 單元驗證
node -e "const ue=require('./src/utils/upstream-error.js'); ..."
```

```
✅ 偵測: upstream_waf_challenge | retryAfter=30
✅ choices 正常通過, 熔斷狀態: {strikes:0,open:false}
✅ 熔斷狀態: {strikes:3,open:true,remainingSeconds:60}
✅ 熔斷阻擋: Qwen 上游繁忙... | breakerOpen=true
```

```bash
# 端到端（尖峰過後，免額實測）
curl -X POST http://127.0.0.1:3000/v1/chat/completions ...
```

```
HTTP 200  "Hi! How can I help you today?"
```

```bash
# 走完整 chat-proxy 鏈路
curl -X POST http://127.0.0.1:3456/v1/chat/completions ...
```

```
"echo \"Docker 是一種將應用及其依賴打包成容器...\""
```

---

## 用戶決策紀錄

**堅持只用免額（chat.qwen.ai），不使用百煉付費。**

先前為驗證可用性曾暫時加入 `bailian-free` provider，已於同日全部撤回：

| 檔案                                      | 還原內容                                                           |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `projects/.opencode/opencode.json`        | 移除 `bailian-free` provider，model 還原 `qwen-proxy/Qwen3.6-Plus` |
| `.opencode/opencode.jsonc`                | 同上（移除整段）                                                   |
| `plugins/model-router/hardware-detect.js` | high/mid/low 三級還原原本地代理模型                                |
| `plugins/model-router/auto-model.js`      | 電池降級還原 `qwen-proxy/qwen-turbo`                               |
| `~/.opencode/dashscope.key`               | 已刪除                                                             |

殘留檢查：`grep -rn "bailian"` → 完全清除 ✅

---

## 使用建議

| 時段（台灣） | UTC         | 預期                      |
| ------------ | ----------- | ------------------------- |
| 00:00–06:00  | 16:00–22:00 | ⚠️ 尖峰，可能 challenge   |
| 06:00–15:00  | 22:00–07:00 | ✅ 通常可用               |
| 15:00–24:00  | 07:00–16:00 | ❌ 尖峰，高機率 challenge |

**遇到 503 時**：等 `Retry-After` 秒數後重試，不要連續重試（會加重 IP 判定）。

---

## 相關

- `qwen2api-dev/docs/2026-10-17-token-revoked-fix.md`
- lesson `2026-10-17-2345-qwen-token-revoked-root-cause.md`
- lesson `2026-10-18-0005-qwen-free-quota-waf-block.md`（其中「IP 封鎖」結論已被本文修正）
- 原作者 issue #180、commit 81b75ad / b19384b / 91e02d2
