# Session stderr 滯留訊息清理

## 技術層（fact）

**問題**: Provider 錯誤訊息（ECONNREFUSED 重試、連線失敗、max retries）透過三層管道噴到對話框：

1. `process.stderr.write()` → TUI 直接顯示
2. `Bus.publish(Session.Event.Error)` → 事件觸發顯示
3. `Session.updateMessage({error})` → DB 儲存後讀出顯示

**根因**: processor.ts/prompt.ts 在錯誤處理時直接寫 stderr，且把錯誤訊息存進 DB，使用者不斷看到技術性錯誤干擾對話。

**解決**:

1. `processor.ts` — 移除三處 `process.stderr.write()`（重試訊息、連線失敗、max retries）
2. `processor.ts` — 移除 `input.assistantMessage.error = error` + `Session.updateMessage()`
3. `processor.ts` — 移除 `Bus.publish(Session.Event.Error, ...)`
4. `prompt.ts` — 移除 `process.stderr.write("[session] ❌ ...")`（漏網之魚）

**結果**: stderr output = 0 bytes，錯誤僅寫 log 不進對話框。

**原則**: 內部技術性錯誤訊息僅寫 log，不進 UI 對話框。使用者只需要知道「請求失敗」，不需要看到 ECONNREFUSED。

## 相關檔案

- `src/session/processor.ts` — stderr / Bus / DB error 移除
- `src/session/prompt.ts` — stderr 移除
- `TROUBLESHOOT.md` — 滯留訊息診斷流程

## 相關文件

- [開發機輕量化與錯誤隔離 wiki](../wiki/03-問題修復/Qwen2API-開發機輕量化與錯誤隔離.wiki)
- `projects/independent/qwen2api-dev/AGENTS.md` — 專案規範
