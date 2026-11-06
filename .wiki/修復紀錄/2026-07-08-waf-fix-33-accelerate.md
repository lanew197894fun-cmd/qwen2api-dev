# Fix 33: WAF 加速 — `_cbRecordFail(true)` + SSE 降級略過 + 防雙重計數

## 日期

2026-07-08 (Fix 33，於 v5 完成後發現)

## 問題

Chrome 3 個請求就被永久禁用（8 failures 門檻），因為：

1. **`_cbRecordFail()` 未傳 isWaf** → `_wafMode` 永遠 false → Chrome timeout 維持 15s 不縮短
2. **SSE 雙重 retry**（temp page → main page）每次失敗均計入 CB.failures，2×4=8 快速填滿
3. **request.js 已計 `_consecWafBlocks++`** → Chrome 內部 `_cbRecordFail()` 重複計數

環境限制：開發環境無 `DASHSCOPE_API_KEY`，DashScope 降級不可用，所有壓力在 Chrome/axios 路徑上。

## 根因

- `sendChatRequest` 內外層雙重逾時機制（request.js 的 15s AbortSignal + chrome-fetch.js 的 20s SSE evaluate）未協調計數
- SSE 失敗→main page 降級在 WAF 風暴中完全無意義（main page 會遭遇相同 WAF），卻浪費 20s
- `_cbRecordFail` 設計時未預期連續失敗 = WAF 風暴，未啟動 `_wafMode` 加速

## 修復

### chrome-fetch.js 三處修改

| #   | 修改                    | 位置                                        | 說明                                                            |
| --- | ----------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| 1   | `_cbRecordFail(true)`   | init fail (line 395) + SSE fail (line 1122) | 傳遞 WAF 標記啟動 `_wafMode`                                    |
| 2   | SSE 降級略過            | line 1015-1027                              | `signal?.aborted \|\| CB._wafMode` 跳過 main page retry，省 20s |
| 3   | `if (!signal?.aborted)` | line 1122                                   | 防雙重計數：request.js 已計 `_consecWafBlocks++`，SSE 不重複計  |

### 預期效果

- 第 1 請求：15s Chrome + SSE 20s×2 = ~35s 失效 → `_wafMode=true`
- 第 2 請求起：8s Chrome + SSE 略過 = ~8s 快速降級 axios
- 斷路器計數減半：每請求 1 次（request.js 計數）而非 3 次（request.js + temp SSE + main SSE）

## 翻車鐵律（新增）

- `_cbRecordFail(isWaf)` — **永遠傳遞正確標記**，預設 false 導致 WAF 風暴無法提速
- `signal.aborted` 的請求，Chrome 內部不應再計斷路器 — request.js 已計一次
- SSE retry 在 WAF 風暴中無意義 — `_wafMode` 或 `signal.aborted` 時直接跳過

## 驗證

無真實金鑰環境下，等待實際運行觀察 Chrome 永久禁用前請求數從 3 → 5+，SSE retry log 消失。
