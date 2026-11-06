# Fix 32: WAF 斷路器加速 + 空內容風暴抑制 + DashScope 自動降級

## 摘要

根治上游 WAF（Aliyun baxia）雙重校驗導致的全域空內容停滯。修正三大核心路徑：Chrome 斷路器恢復過慢、request.js 無連續 WAF 追蹤、chat-proxy.js 空內容重試 timeout 固定。

## 修改範圍

| 檔案                                 | 修改內容                                                          |
| ------------------------------------ | ----------------------------------------------------------------- |
| `qwen2api/src/utils/chrome-fetch.js` | 階梯式斷路器恢復、WAF 模式感知、隨機 viewport + google 預導航繞過 |
| `qwen2api/src/utils/request.js`      | 連續 WAF 計數、DashScope 自動降級、動態 Chrome timeout            |
| `qwen2api-plugin/src/chat-proxy.js`  | 空內容風暴計數、動態重試 timeout、ts 順序 bug 修復                |

## 🔥 翻車點（絕對不要再犯）

### 1. `_lastGlobalEmptyAt.ts` 計時順序錯誤

```
// ❌ 錯誤：先更新 ts 再計算 count → 差值永遠為 0
_lastGlobalEmptyAt.ts = _tsNow;
_lastGlobalEmptyAt.count =
  _tsNow - _lastGlobalEmptyAt.ts < X ? ...  // 永遠 true！

// ✅ 正確：先計算 count 再更新 ts
_lastGlobalEmptyAt.count =
  _tsNow - _lastGlobalEmptyAt.ts < X ? ...  // 用舊 ts 計算
_lastGlobalEmptyAt.ts = _tsNow;              // 再更新
```

### 2. Chrome 斷路器永久禁用鎖死 5 分鐘

- WAF 通常 1-2 分鐘恢復，鎖死 5 分鐘 = 無謂空窗期
- ✅ 改為階梯式恢復：首次 2 分、二次 3 分、三次+ 1 分

### 3. `_freshInitPage` 全無 WAF 繞過

- 直接導航 chat.qwen.ai → 容易被 WAF 挑戰頁面攔截
- ✅ 改為先導航 google.com 建立正常 session，再跳轉目標站

### 4. request.js 無連續 WAF 阻擋追蹤

- 每次 WAF 阻擋獨立處理，無累積計數 → 無法觸發 DashScope 自動降級
- ✅ 新增 `_consecWafBlocks`，連續 3 次 WAF 自動切 DashScope

### 5. Chrome timeout 固定不變

- WAF 阻擋時仍等 15s/25s → 累積浪費時間
- ✅ 改為 WAF 模式 8s，備用 12s

### 6. 空內容重試 timeout 固定 5s

- WAF 風暴時仍每個候選等 5s
- ✅ 改為風暴計數自動縮短：5s → 2.5s → 1.5s

### 7. `buildErrorResponse` 曾省略 content key

- 導致 opencode 客戶端顯示空白/停滯（已修復，`content: ""`）
- ✅ 永遠保證 content 欄位存在，至少為空字串

### 8. `_cbRecordFail` 未傳遞 WAF 資訊

- 無法區分 WAF 阻擋 vs 真實失敗 → 斷路器策略單一
- ✅ 新增 `isWaf` 參數，追蹤 WAF 模式

## 翻車鐵律

1. **計時邏輯**：先取舊值計算，再更新新值（ts/count 等）
2. **WAF 狀態**：永遠認為 WAF 會波動，斷路器應快速恢復而非鎖死
3. **連續失敗**：追蹤連續計數，不要每個失敗獨立處理
4. **timeout**：根據 WAF 模式動態調整，不要固定一個值
5. **錯誤訊息**：永遠 `content: ""`，禁止省略 content key
6. **預導航**：面對 WAF 時，先導航正常站點再跳轉目標

## 驗證

- Chrome 斷路器：連續 8 次失敗 → 永久禁用 → 2 分後自動恢復
- WAF 風暴抑制：連續 3 次空內容 → timeout 自動縮至 2.5s
- DashScope 降級：連續 3 次 WAF 阻擋 → 自動切 DashScope（有 key 時）
