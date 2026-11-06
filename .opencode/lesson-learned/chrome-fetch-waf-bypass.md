# Chrome Fetch Proxy WAF 繞過方案

## 問題

阿里雲 WAF 使用 JA3 TLS 指紋 + context-bound `acw_tc` token 雙重檢測，阻擋所有非瀏覽器 HTTP 客戶端：

- Bun fetch（BoringSSL）— 阻擋
- curl（OpenSSL）— 阻擋
- headless Chrome（puppeteer headless:true）— 阻擋
- Python requests/httpx — 阻擋

## 解決方案

使用**非無頭 Chrome**（`headless: false`）+ `DISPLAY=:0` + `page.evaluate` 在瀏覽器 context 中發送 API 請求。

## 核心原理

1. **WAF 挑戰通過**：啟動 Chrome（headless: false），導航至 `chat.qwen.ai`，等待 WAF 的 JavaScript 挑戰完成（約 2-3 秒）
2. **瀏覽器 context 發請求**：透過 `page.evaluate()` 在真實瀏覽器環境中呼叫 `fetch()`，攜帶完整的瀏覽器 TLS 指紋與 Cookie context
3. **SSE 橋接**：使用 `exposeFunction()` 將瀏覽器中的 SSE chunk 資料透過 callback 橋接到 Node.js `PassThrough` stream

## 關鍵程式碼

```javascript
// 啟動非無頭 Chrome
const browser = await puppeteer.launch({
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage', ...]
});

// 通過 WAF 挑戰
await page.goto('https://chat.qwen.ai');
await page.waitForFunction(() => document.title.includes('Qwen'), { timeout: 45000 });

// 在瀏覽器 context 中發送 SSE 請求
page.evaluate(async (reqId, url, payload, token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, ... },
    body: JSON.stringify(payload)
  });
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    window.__qwenFetchOnData(reqId, chunk); // exposeFunction 橋接
  }
}, ...);
```

## 注意事項

- **需要 X11**：必須有 `DISPLAY=:0` 環境變數（Xvfb 或實體顯示器）
- **Chrome 版本**：需安裝 `google-chrome-stable`，`puppeteer-core` 不自動下載
- **非關鍵錯誤**：Chrome 啟動時的 `signin token decrypt failed` 和 `GCM DEPRECATED_ENDPOINT` 是已知的非關鍵錯誤，不影響功能
- **健康監控**：Chrome 可能 crash，需每 60 秒健康檢查並自動恢復
- **記憶體**：Chrome 佔用約 200-400MB，需要足夠記憶體

## 模型名稱變更

上游 Qwen API 模型名稱已變更，需硬編碼映射：

| 舊名稱          | 新名稱           |
| --------------- | ---------------- |
| qwen-plus       | qwen3.7-plus     |
| qwen-max        | qwen3-max        |
| qwen-turbo      | qwen3-turbo      |
| qwen-coder-plus | qwen3-coder-plus |
| qvq-plus        | qvq-72b-preview  |

## 相關檔案

- `src/utils/chrome-fetch.js` — Chrome Fetch Proxy v3 核心實作
- `src/utils/request.js` — 整合 Chrome Fetch 為主路徑，axios 降級
- `src/utils/chat-helpers.js` — 硬編碼模型名稱映射表
- `src/models/models-map.js` — Chrome Fetch 取得模型列表
- `src/server.js` — Chrome Fetch 初始化 + 健康監控
