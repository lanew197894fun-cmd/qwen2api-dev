# knowledge-wiki-plugin 執行停滯修復記錄

> 分類：修復紀錄
> 日期：2026-07-08
> 標籤：knowledge-wiki-plugin, stall, timeout, error-isolation, auto-degradation

---

## 問題描述

knowledge-wiki-plugin 在 OpenCode 環境中出現兩個核心問題：

1. **本地發現未出現** - 插件安裝後未出現在本地發現清單中
2. **執行停滯 / 忽然停止** - 插件載入時卡住，導致整個對話流程停滯

## 根本原因診斷

### 問題 1：本地發現未出現

**原因**：KnowledgeWikiPlugin 僅註冊了 `tool`（工具），未註冊 `mcp-server` 或任何服務端點。OpenCode 的「本地發現」機制預期插件暴露 MCP Server 端點，但本插件採用 Internal Tool Provider 模式。

**現狀**：這是架構層級的設計選擇。Internal Tool Provider 模式輕量且不需獨立進程，但無法被 MCP 發現機制掃描到。若需要支援本地發現，需重構為 MCP Server 架構。

### 問題 2：執行停滯

找出 3 項根本原因：

| #   | 原因                                                   | 檔案                         | 影響                                                                              |
| --- | ------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| 1   | `ProviderManager.activate()` 對 `p.init()` 無超時控制  | `provider-manager.ts` L14-22 | LanceDB 初始化若阻塞（如 native addon 掛起、磁碟 I/O 卡住），整個插件載入永久掛起 |
| 2   | 無健康檢查自動降級機制                                 | `provider-manager.ts` L42-44 | Provider 失效後 `get()` 仍返回無回應實例，不嘗試降級到備用 Provider               |
| 3   | 依賴 `globalThis.__opencode_knowledge_provider__` 脆弱 | `index.ts` L36-43            | 若外部環境未正確注入此全域變數，或注入物件不完整，拋出未捕獲異常                  |

**連鎖效應**：插件停滯 → OpenCode 等待工具回應逾時 → 模型重新發送請求 → 看起來像模型重複執行

## 修復內容

### `provider-manager.ts`

1. **加入 `withTimeout()` 輔助函數**（L5-16）：使用 `Promise.race` 對 `p.init()` 施加 30 秒超時
2. **`activate()` 加入 try/catch + 自動降級**（L38-73）：初始化失敗時自動嘗試 fallback Provider
3. **`healthCheck()` 加入自動降級交換**（L101-119）：Active Provider 健康檢查失敗時自動交換到 Fallback
4. **加入 `isDegraded()` 狀態查詢**（L89-91）：外部可查詢是否處於降級模式
5. **加入 `initTimeoutMs` 可配置參數**（L24）：預設 30 秒

### `index.ts`

1. **FileProvider 改為強制 fallback 註冊**（L37-40）：無論 LanceDB 是否存在，FileProvider 永遠作為最後防線
2. **LanceDB 初始化包入 try/catch**（L51-59）：隔離錯誤，防止崩潰傳播
3. **LanceDB 失敗時自動啟動 FileProvider**（L67-80）：即使 LanceDB 不存在或初始化失敗，插件仍然可用
4. **當無 Provider 可用時回傳 `undefined` tools**（L82-83）：避免回傳空陣列導致型別錯誤
5. **完整錯誤日誌**：每個失敗階段都輸出 `[knowledge-wiki-plugin]` 前綴的錯誤訊息

## 關於模型重複行為

模型重複輸出同內容的可能性分析：

| 類型             | 判斷依據                                         | 歸因                                                                       |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| **思考過程重複** | 模型在生成最終回答前，多次輸出相同的推理步驟     | 模型自身的 Chain-of-Thought 行為，與插件無關                               |
| **實際重複執行** | 工具被實際呼叫多次（可從日誌中看到多次執行紀錄） | **插件停滯導致**：host 系統（OpenCode chat-proxy）在工具呼叫逾時後發起重試 |

**結論**：在修復前，插件停滯時 host 很可能因逾時而重試工具呼叫，導致**實際重複執行**。本次修復加入的 30 秒超時與錯誤隔離可以解決此問題——插件要嘛迅速完成初始化，要嘛乾淨降級，**不再永久掛起觸發重試**。

## 修改檔案清單

- `knowledge-wiki-plugin/src/provider-manager.ts` - 完整改寫（60→136 行）
- `knowledge-wiki-plugin/src/index.ts` - 重大改寫（65→89 行）

## 驗證結果

- `bun build` 編譯成功（77 modules, 54ms）
- 無型別錯誤
- 向後相容：既有 `getTools()`、`FileProvider`、`IKnowledgeProvider` 介面未修改

---

## 元數據

- 建立日期：2026-07-08
- 使用次數：0
