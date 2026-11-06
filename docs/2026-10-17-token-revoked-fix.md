# 2026-10-17 修改追蹤：Qwen Token 撤銷診斷與修復

> 追蹤用文件。git diff 因專案先前已大幅重構（36 檔 6330 行）無法區分本次修改，
> 故以「檔案 + 行號 + 校驗碼 + 改動摘要」精確記錄。

---

## 一、變更檔案清單（5 個）

| 檔案                            | 行數 | MD5                                | 修改區段                                       |
| ------------------------------- | ---- | ---------------------------------- | ---------------------------------------------- |
| `src/utils/token-manager.js`    | 543  | `fa807a63ea1ebfd664f25d198f89dcb7` | L18-40, L313-326, L344-380, L378-500, L505-540 |
| `src/utils/account.js`          | 1386 | `a987ec3a98192eaf22c2bb686a0ff74f` | L83, L116-140, L144, L780-790                  |
| `src/utils/account-rotator.js`  | 333  | `d3c93506f5b4f6823951e5fb414b6150` | L168-180, L216-221                             |
| `src/utils/data-persistence.js` | 410  | `94619726b22ee2f3cb677cd6662086ad` | L255-268, L294-343                             |
| `src/routes/inject.js`          | 213  | `016f02520af94bb8f3e41e8863f66fcd` | L127-131                                       |

新增測試（6 檔，`qwen2api/test/`）：
`token-revoked.verify.js`、`token-revoked.live.js`、`token-concurrent.live.js`、
`account-revoked.live.js`、`e2e.request.js`、`inject-cookies.js`

---

## 二、逐檔改動明細

### 1. `src/utils/token-manager.js`

**L18-40 — 新增持久化回呼機制**

```js
this.persistHook = null;          // 建構子
async _persist(email, patch) {}   // 包 try/catch，失敗不中斷主流程
```

> 目的：refresh_token 每次刷新都輪替，必須即時落盤。
> 舊碼完全不落盤 → 重啟必用舊 token → TOKEN_REVOKED（**根因**）

**L313-326 — 新增 `_parseRefreshResponse(response)`**

```js
{
  (code, revoked, data);
}
```

> Qwen 回 HTTP **200** 但 header 標 `x-actual-status-code: 401` +
> `x-error-code: TOKEN_REVOKED`，axios 不會 throw。
> 舊碼只讀 `data.data.access_token` → 真相被掩蓋成「未回傳 access_token」。

**L344-376 — `refreshViaCookie` 改為共享 Promise**

```js
if (account._refreshPromise) return account._refreshPromise;
const run = this._doCookieRefresh(account, cookieStr);
account._refreshPromise = run;
```

> ⚠️ **我一度引入的 bug**：先用布林鎖 `_cookieRefreshing`，
> 併發呼叫直接 `return null` → 5 個併發請求中 4 個報
> 「無法取得有效的通路令牌」。共享 Promise 後 5/5 成功。

**L378-500 — `_doCookieRefresh`（從 refreshViaCookie 抽出）**

- `revoked` 分支：寫入 `account.tokenError = {code, revoked, at}`、
  清 `token`/`expires`、**保留 cookies**、落盤 `token:null`
- 成功分支：`patch = {token, cookies, refresh_token_expires, expires}` → `_persist()`
- **日誌單位修正**：
  - 舊：`getTokenRemainingHours(accessToken)` → 回傳**小時**，卻印「分鐘」→ `0分鐘`
  - 新：`Math.round((decoded.exp * 1000 - Date.now()) / 60000)` → `15分鐘`

**L505-540 — `ensureFreshToken` 移除降級**

```js
const isBrowserMode =
  account.loginMethod === "browser" || !!account.cookies?.refresh_token;
if (isBrowserMode) return this.refreshViaCookie(account); // 失敗即止
// 只有非 browser 模式才走密碼登入
```

> Qwen 已全面拒絕社群帳號 signin（一律 400），降級只會多打無效請求。

---

### 2. `src/utils/account.js`

**L83** — `const REVOKED_RETRY_COOLDOWN = 30 * 60 * 1000;`

**L116-140 — 新增 `_bindTokenPersist()`**

```js
this.tokenManager.persistHook = async (email, patch) => { ... }
```

同步記憶體欄位 + 呼叫 `dataPersistence.saveAccount`，
並補 `payload.refresh_token`（舊格式相容）。

**L144** — `_initialize()` 開頭呼叫 `this._bindTokenPersist();`

**L780-790 — `_ensureTokenAsync` 加 revoked 冷卻**

```js
if (err?.revoked && Date.now() - err.at < REVOKED_RETRY_COOLDOWN) return;
```

> 撤銷是永久狀態，重試無意義，會造成每請求噴一次的日誌洪水。

---

### 3. `src/utils/account-rotator.js`

**L216-221 — `_isAccountAvailable` 加 revoked 判斷**

```js
if (account.tokenError?.revoked) return false;
```

> revoked 帳戶在重新登入前無法取得任何 token，選中也只會在請求路徑失敗。

**L168-180 — `getStats()` 暴露 `tokenError`**
供 dashboard 顯示「需重新登入」。

---

### 4. `src/utils/data-persistence.js`

**L255-268 — `_saveToFile` 白名單補欄位**

```js
if (accountData.cookies !== undefined) merged.cookies = accountData.cookies;
if (accountData.refresh_token !== undefined) ...
if (accountData.refresh_token_expires !== undefined) ...
if (accountData.loginMethod !== undefined) ...
```

> **根因**：舊白名單不含 `cookies` → 即使呼叫端傳了也被丟棄。

**L294-343 — `_saveAllToFile` 改 merge 語義**

```js
const pick = (account, existing) => { const merged = {...existing}; ... }
data.accounts = accounts.map(a => pick(a, byEmail.get(a.email) || {}));
```

> **根因**：舊版整筆重建 accounts 陣列（固定欄位重建），
> 每日歸檔時把 browser 帳戶 cookies 整片抹除。

---

### 5. `src/routes/inject.js`

**L127-131 — 重注入 cookie 時清除診斷標記**

```js
existing.tokenError = null;
existing._refreshPromise = null;
accountManager.accountRotator.resetFailures(email);
```

> 否則 revoked 標記會讓帳戶永久不可用，重注入也無法復原。

---

## 三、驗證紀錄

```bash
cd /home/reamaster/opencode-manager/projects/independent/qwen2api-dev/qwen2api
node test/token-revoked.verify.js      # ✅ revoked 辨識 + 不降級
node test/token-concurrent.live.js     # ✅ 併發 5/5
node test/token-revoked.live.js        # ✅ 真實端點診斷
node test/account-revoked.live.js      # ✅ 整合生命週期
node test/e2e.request.js               # 端到端
```

實際輸出：

```
tokenError: {"code":"TOKEN_REVOKED","revoked":true}
✅ revoked 帳戶已被輪詢器排除（可用: []）
併發 5 次 → 成功: 5 / 5，結果一致: true
磁碟 token: 已清空 ✅  cookies 保留: 18/18 ✅
服務日誌: 有效期: 15分鐘 ✅  「無法取得有效的通路令牌」已消失 ✅
```

---

## 四、重新注入 cookie 流程

```bash
# 1. 從瀏覽器 DevTools 複製 cookies JSON 存檔
node test/inject-cookies.js <cookies.json>

# 2. 重啟服務（必須！不會熱載入）
for p in $(pgrep -f "src/start.js"); do kill -9 $p; done

# 3. 看日誌
tail -f ../logs/run-<最新時間戳>/qwen2api.log
```

---

## 五、遗留問題（非程式端）

**阿里雲 WAF 封鎖本機 IP** — SSE 回：

```json
{
  "ret": [
    "FAIL_SYS_USER_VALIDATE",
    "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"
  ],
  "data": { "url": ".../punish?...&action=captcha" }
}
```

帳戶/token 經實測完全正常（建立 chat 回 `success: true`）。

處理方向（需人工決策）：

- 更換出口 IP（代理 / Tailscale exit node）
- 降低請求頻率 + 模擬人機延遲
- 改用官方 API 或其他上游供應商

---

## 六、重啟注意事項

| 項目        | 值                                                                    |
| ----------- | --------------------------------------------------------------------- |
| 程序        | `bun src/start.js`（**不會自動重載程式碼**）                          |
| 啟動器      | `qwen2api-dev` 統一啟動器（Ctrl+C 停止全部）                          |
| 日誌位置    | `qwen2api-dev/logs/run-<timestamp>/qwen2api.log` + `.err`             |
| 舊日誌      | `qwen2api/logs/app.log`（已停用，非實時）                             |
| Chrome 路徑 | `~/.cache/puppeteer/chrome/linux-151.0.7922.34/chrome-linux64/chrome` |

---

## 相關 lesson

- `projects/.opencode/skill/lesson/2026-10-17-2345-qwen-token-revoked-root-cause.md`
- 維基：`knowledge-autosave/scripts/.opencode/03-問題修復/qwen2api-refresh-token撤銷主因修復-2026-10-17.md`
- `qwen2api-auto-get-token-fix.md`、`qwen2api-stability-fix-2026-07-20.md`
