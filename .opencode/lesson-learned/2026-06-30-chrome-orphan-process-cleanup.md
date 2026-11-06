# Chrome 孤兒進程清理修復

## 技術層（fact）

**問題**: qwen2api `start.js` 收到 SIGTERM 後只 `process.exit(0)`，從未呼叫 `chromeFetch.destroy()`，導致每次重啟 Chrome 變成孤兒進程，累積 9 個幽靈 Chrome 吃 ~944 MB RAM，最終 OOM/system kill。

**根因**: `start.js` 的 exit handlers 只關 HTTP server，沒有清理 Chrome 子進程；Chrome 多進程架構預設產生 9 個子進程，父進程死亡後子進程變孤兒。

**解決**:

1. `server.js` — 加入 `process.on("exit")` handler，退出時同步 `chromeFetch.browser.process().kill("SIGKILL")` 殺掉 Chrome
2. `start.cjs` — 啟動前掃描 cmdline 含 `.chrome-qwen-profile` 的殘留 Chrome 進程並殺掉（二次防護）

**原則**: 任何管理子進程的服務退出時必須同步清理子進程，避免孤兒進程累積。

## 相關檔案

- `qwen2api/src/server.js` — process.on("exit") 清理 Chrome
- `start.cjs` — 啟動前孤兒掃描
- `qwen2api/src/utils/chrome-fetch.js` — destroy() 方法
- `qwen2api/ARCHITECTURE.md` — 開發機輕量化配置

## 相關文件

- [開發機輕量化與錯誤隔離 wiki](../wiki/03-問題修復/Qwen2API-開發機輕量化與錯誤隔離.wiki)
- `projects/independent/qwen2api-dev/AGENTS.md` — 專案規範
