# 2026-10-18 免額優先修復：追蹤文件

> 追蹤用文件。git diff 因專案先前已大幅重構而無法區分本次修改，
> 故以「檔案 + 行號 + MD5 校驗碼」精確記錄。

---

## 一、本次一句話總結

**Qwen 拒絕空內容的根因是 `version` header 版本過時（0.2.63/0.2.67 → 0.3.12）**；
同時把百煉從「第一跳」降為「需明確允許的最後備援」，杜絕不必要付費。

---

## 二、變更檔案清單（6 檔）

| 檔案                                   | 行數 | MD5                                | 修改區段                                                    |
| -------------------------------------- | ---- | ---------------------------------- | ----------------------------------------------------------- |
| `qwen2api/src/utils/request.js`        | 1210 | `77cc4d4cd2afda6d30b8c7291648bc1e` | L554, L600-681, L690, L850-900, L988-995, L235/830/954/1168 |
| `qwen2api/src/utils/curl-fetch.js`     | 389  | `39f4c96920bdcea5febc36032befccc1` | L60-106, L207, L255-270, L382                               |
| `qwen2api/src/utils/chrome-fetch.js`   | —    | `26d6f1fcc013fc7cff1b5615c66055f6` | L767, L1021, L1135（僅 version）                            |
| `qwen2api/src/models/models-map.js`    | 165  | `ff22e7f28b4c1703611e1ec6d4edae7d` | L30, L57, L115（僅 version）                                |
| `qwen2api/src/controllers/chat.js`     | —    | `6ce70782f4edc5d9ea96d2dad66a7da0` | L11-44, L604, L775-790, L1273                               |
| `qwen2api/src/utils/upstream-error.js` | 181  | `c18eb8a728d57017ee71c77198dc9fa4` | 新增（上一輪）                                              |

`.env` 新增兩行（非程式碼）：

```
DASHSCOPE_ALLOW_FALLBACK=false
FREE_TIER_ONLY=true
```

---

## 三、四個主因與修法

### 主因 1：`version` header 版本過時 ★★★（關鍵）

**症狀**：HTTP 200、`finish_reason: stop`、`content: null`、
`usage.completion_tokens: 0` → 假成功。

**根因**：程式送 `version: "0.2.63"` / `"0.2.67"`，
但 Qwen 前端已升到 `0.3.12`。Qwen 接受連線但不產生內容。

**證據**：refresh 端點驗證時（早於本次修改）已確認前端用 `0.3.12`，
且 refresh 成功時必須帶此版本。

**修法**：10 處統一為 `0.3.12`

| 檔案              | 行號                |
| ----------------- | ------------------- |
| `request.js`      | 235, 830, 954, 1168 |
| `chrome-fetch.js` | 767, 1021, 1135     |
| `models-map.js`   | 30, 57, 115         |

**效果**：空回覆 → 正常回覆，2.4–2.7 秒。

---

### 主因 2：DashScope 優先於免額 ★★（付費漏洞）

**根因**：`sendChatRequest` 開頭直接 `if (DASHSCOPE_KEY) { 試百煉 }`，
失敗才落到免額。導致：

1. 每次請求先燒一次百煉額度（即使免額完全正常）
2. 百煉免額耗盡（`insufficient_quota`）時額度在第一跳就被吃掉，
   免額路徑根本沒被嘗試

**修法**：

```
sendChatRequest
  ├─ sendFreeRequest(body)          ← 第一跳（免額主路線）
  │    └─ 成功 → 直接返回，完全不碰百煉
  └─ DASHSCOPE_ALLOW_FALLBACK === "true"？
       ├─ 是 → 試百煉
       └─ 否 → 記錄訊息後返回（避免付費）
```

抽出 `sendFreeRequest()`（`request.js` L690）成為獨立函式，
內含熔斷攔截 + 帳戶取得 + chat_id + curl/Chrome/axios 三層。

**對應行號**：`request.js` L600-681（流程）、L681（返回免額）、L690（函式起點）

---

### 主因 3：`FREE_TIER_ONLY` 未設定 ★

**根因**：`.env` 沒有此變數 → `chat-proxy.js` 的 `_isPaidModel()` 過濾不生效 →
路由可能選到 `qwen-max` / `qwen-turbo` / `Qwen3-Coder` 等
實測回 `Model not exist` 的舊模型名。

**修法**：`.env` 補 `FREE_TIER_ONLY=true`

**實測可用模型**（2026-10-18 驗證）：

| 模型                                      | 狀態               |
| ----------------------------------------- | ------------------ |
| `qwen3.8-omni-flash`                      | ✅                 |
| `qwen3.8-omni-flash-thinking`             | ✅                 |
| `qwen3.7-plus`                            | ✅                 |
| `qwen3.6-plus`                            | ✅                 |
| `qwen3.5-omni-plus`                       | ✅                 |
| `qwen-max` / `qwen-turbo` / `Qwen3-Coder` | ❌ Model not exist |

---

### 主因 4：curl 路徑漏判 challenge ★

**症狀**：日誌只見
`[curl-impersonate] SSE 無有效內容（疑似 WAF 隱形阻擋），降級`
但從未記錄任何 challenge。

**根因**：`curlSse` 在 `data` listener 掛載**之前**就把首幀寫入
`PassThrough`，5 秒窗口內讀到空字串 → 一律判「無有效內容」→
降級 → 重試 hammer Qwen。

**修法**（兩層）：

**a) `curl-fetch.js` 保留累積緩衝**

```js
const _CHALLENGE_BUF_MAX = 4096;
let _challengeBuf = "";                              // L82
function _looksLikeChallenge(text)                    // L75
function takeBuffered()                               // L102
```

`curlSse` 開頭重置狀態（L207），轉發前累積並偵測（L255-270）。

**b) `request.js` 提前補讀 + 三態分流**

```js
let buf = curlFetch.takeBuffered() || ""; // L858
// 收到資料即時判定（不等滿 5 秒）
if (/challenge 正則/.test(buf)) resolve("challenge");
if (/"content":"[^"]+"/.test(buf)) resolve("ok");
// 5 秒後兜底判定
if (hasData === "challenge") {
  noteChatChallenge();
  return 503;
} // L890
```

**c) axios 路徑用 tee 重建串流**

```js
const _peekChallengeInStream = async (s) => {...}     // L554
```

回傳 `{ challenge, stream, peeked }`。
⚠️ **關鍵陷阱**：Axios stream 一旦有 data listener 消費就無法 `unshift`，
必須用 `PassThrough` + `pipe` 重建，否則正常回應會遺失首幀。

---

## 四、chat challenge 處理鏈（完整）

```
Qwen 回 HTTP 200 + {ret:['FAIL_SYS_USER_VALIDATE','被挤爆啦']}
        ↓
curl-fetch.js  _CHALLENGE_RE 比對 → _challengePayload / _challengeBuf
        ↓
request.js     hasData === "challenge"
               或 axios: _peekChallengeInStream().challenge
        ↓
               noteChatChallenge()  → strikes++，滿 3 次開熔斷 60 秒
        ↓
               return { status:false, error:"waf_challenge" }
        ↓
chat.js        buildUpstreamErrorResponse("waf_challenge")   L1273
        ↓
               HTTP 503 + Retry-After: 30
               { error: { type:"upstream_waf_challenge" } }
```

熔斷開啟時（`assertChatChallengeBreakerClosed`，`request.js` L690 起）
直接回 `waf_breaker_open`，完全不打 Qwen。

---

## 五、驗證紀錄

```bash
cd /home/reamaster/opencode-manager/projects/independent/qwen2api-dev
for p in $(pgrep -f "src/start.js"); do kill -9 $p; done   # 必須重啟才生效
```

連續 5 次實測：

```
#1 HTTP 200 2.74s ✅
#2 HTTP 200 2.60s ✅
#3 HTTP 200 2.65s ✅
#4 HTTP 200 2.36s ✅
#5 HTTP 200 2.68s ✅
```

**百煉呼叫次數：0**

```
grep -c "DashScope" logs/run-*/qwen2api.log → 0
grep -c "DashScope" logs/run-*/qwen2api.err → 0
```

實際路線：

```
🌐 [curl-impersonate] 請求成功 × 5
```

單元測試（`_peekChallengeInStream`）：

```
案例1 challenge 判定=true(期望true)  ✅
案例2 正常+後續 判定=false(期望false) ✅ 回推長度=84
```

---

## 六、常見陷阱（下次別再踩）

| 陷阱                | 說明                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| **listener 掛太晚** | curl/PassThrough 先寫後讀 → 首幀遺失 → 誤判「無有效內容」                |
| **unshift 無效**    | Axios stream 被 data listener 消費後無法 unshift，必須 tee 重建          |
| **HTTP 200 ≠ 成功** | Qwen challenge 回 200 但無 `choices`，不檢查會回假成功                   |
| **單位錯誤**        | `getTokenRemainingHours()` 回傳小時，卻印成「分鐘」→ 15 分鐘顯示 `0分鐘` |
| **模型名過時**      | `qwen-max`/`qwen-turbo`/`Qwen3-Coder` 實測都是 `Model not exist`         |
| **日誌誤導**        | `logs/app.log` 是舊檔，實時日誌在 `logs/run-<timestamp>/`                |

---

## 七、跨裝置設計確認

`config/paths.js` 設計符合「跨裝置 = 裝置啟動路徑，非跨裝置連線」：

| 項目           | 實作                                      |
| -------------- | ----------------------------------------- |
| 路徑決定       | `TARGET_OS`（env）> `process.platform`    |
| 執行依據       | 實際 host OS                              |
| 唯一跨裝置連線 | `telegram-memory-bridge`（Tailscale API） |
| 衍生路徑       | 一律從 `ROOT` 推算，改路徑只改一處        |

本次未修改此檔。

---

## 相關 lesson

- `projects/.opencode/skill/lesson/2026-10-18-0105-chat-challenge-breaker.md`
- `projects/.opencode/skill/lesson/2026-10-17-2345-qwen-token-revoked-root-cause.md`
- 追蹤文件：`docs/2026-10-17-token-revoked-fix.md`、`docs/2026-10-18-chat-challenge-breaker.md`
- 原作者：Rfym21/Qwen2API commit `81b75ad`、issue #180
