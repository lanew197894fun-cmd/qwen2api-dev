# /api/ask 強化：自動帶入記憶+知識庫+維基+經驗教訓

## 問題描述

使用者問問題時，模型只依據記憶回答，無法自動取得知識庫、維基、經驗教訓中的相關資訊。

## 解決方案

強化 `/api/ask` 端點，在呼叫模型前自動搜尋四種來源：

1. **記憶** — 向量搜尋（原本就有）
2. **知識庫** — `.opencode/knowledge/` 全文關鍵詞比對
3. **維基** — `.opencode/wiki/` 全文關鍵詞比對
4. **經驗教訓** — `.opencode/lesson-learned/` 全文關鍵詞比對

## 實作方式

- 新增 `searchDir(dir, query, max)` 函數（基於關鍵詞的 .md 全文搜尋）
- 修改 `/api/ask` 中的 system prompt 告知模型有四種來源
- 回傳結果包含各來源的命中數量

## 相關檔案

- `telegram-memory-bridge/src/api.ts` — `searchDir()` 函數 + 強化後的 `/api/ask`
- `telegram-memory-bridge/src/index.ts` — Config 新增 `lessonPath`、`opencodeRoot`
- `.opencode/SKILL.md` — 智慧上下文說明
- `.opencode/knowledge/qwen2api-architecture.md` — 架構文件補充說明

## 等級

P4-最佳實踐
