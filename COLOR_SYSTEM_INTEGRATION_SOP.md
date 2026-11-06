# qwen2api-dev 統一色彩系統整合 SOP

> **適用範圍**：qwen2api-dev 專案下所有 JavaScript/TypeScript 模組的日誌色彩化整合
> **版本**：1.0 | **建立日期**：2026-07-02 | **狀態**：生效中

---

## 1. 目的

建立統一的終端機色彩輸出標準，解決關鍵錯誤（如 `[系統錯誤]`）在大量日誌中被忽略的問題，確保所有模組日誌格式一致、可讀性高、環境自適應。

---

## 2. 核心原則

| 原則           | 說明                                                           |
| -------------- | -------------------------------------------------------------- |
| **單一來源**   | 所有色彩邏輯集中在 `src/color.js`，禁止分散定義                |
| **統一引入**   | 所有模組採用相同引入模式，確保一致性                           |
| **語義色彩**   | 使用語義命名（primary/error/warning/info），而非硬編碼顏色值   |
| **環境自適應** | 自動偵測 `FORCE_COLOR`/`NO_COLOR`/`TERM`/TTY，無色環境自動降級 |
| **錯誤高可見** | `[系統錯誤]` 必須紅色加粗，極難被忽略                          |

---

## 3. 色彩系統規格

### 3.1 語義色彩對照表

| 語義名      | Hex       | 用途                     | 對應 opencode theme |
| ----------- | --------- | ------------------------ | ------------------- |
| `primary`   | `#5c9cf5` | proxy 標籤、主要資訊     | primary             |
| `secondary` | `#9d7cd8` | evolution 標籤、次要資訊 | secondary           |
| `accent`    | `#fab283` | push/watch 標籤、強調    | accent              |
| `success`   | `#7fd88f` | 成功訊息、learning ok    | success             |
| `warning`   | `#f5a742` | 警告等級、降級重試       | warning             |
| `error`     | `#e06c75` | 錯誤等級、**系統錯誤**   | error               |
| `info`      | `#56b6c2` | 資訊等級、一般輸出       | info                |
| `text`      | `#eeeeee` | 一般文字                 | text                |
| `muted`     | `#808080` | debug、靜音文字          | textMuted           |
| `dim`       | `#606060` | 次要資訊                 | -                   |

### 3.2 標籤色彩分配

| 模組       | 標籤                                  | 色彩 | 語義色    |
| ---------- | ------------------------------------- | ---- | --------- |
| chat-proxy | `proxy`                               | 藍   | primary   |
| 系統錯誤   | `系統`                                | 灰   | muted     |
| router     | `router`                              | 青   | info      |
| auth 相關  | `auth` / `auth:oauth` / `auth:cookie` | 綠   | success   |
| learning   | `learning`                            | 綠   | success   |
| evolution  | `evolution`                           | 紫   | secondary |
| provider   | `provider`                            | 藍   | primary   |
| auto-judge | `auto-judge`                          | 黃   | warning   |
| hardware   | `hardware`                            | 橙   | accent    |

### 3.3 等級色彩

| 等級      | 色彩       | 語義色       | 使用場景                     |
| --------- | ---------- | ------------ | ---------------------------- |
| DEBUG     | 灰         | muted        | 詳細除錯資訊                 |
| INFO      | 青         | info         | 一般資訊、啟動成功           |
| WARN      | 黃         | warning      | 降級、重試、非致命問題       |
| ERROR     | 紅         | error        | 連線失敗、串流錯誤           |
| SYS_ERROR | **粗體紅** | error + bold | **系統級錯誤，必須立即關注** |

---

## 4. 整合標準流程

### 4.1 新增模組整合步驟

```bash
# 1. 複製標準引入模板到模組頂部
cat >> your-module.js << 'EOF'
import { color, supportsColor } from "./color.js";

const USE_COLOR = supportsColor();
const c = USE_COLOR ? color : {
  error: (m) => m, warn: (m) => m, info: (m) => m, debug: (m) => m,
  tag: (n) => `[${n}]`, level: (l) => l.toUpperCase(),
  bold: (m) => m, dim: (m) => m, primary: (m) => m, secondary: (m) => m,
  accent: (m) => m, muted: (m) => m, success: (m) => m,
  RESET: "", BOLD: "", DIM: ""
};

const log = {
  debug: (...a) => console.log(c.tag("your-tag"), c.level("debug"), c.debug(...a)),
  info: (...a) => console.log(c.tag("your-tag"), c.level("info"), c.info(...a)),
  warn: (...a) => console.warn(c.tag("your-tag"), c.level("warn"), c.warn(...a)),
  error: (...a) => console.error(c.tag("your-tag"), c.level("error"), c.error(...a)),
  sysError: (...a) => console.error(c.tag("系統"), c.bold(c.error("[系統錯誤]")), c.error(...a)),
};
EOF

# 2. 替換所有 console.log/warn/error 為 log.xxx
# 3. 系統級錯誤使用 log.sysError()
# 4. 測試：FORCE_COLOR=1 node your-module.js
```

### 4.2 標準 Log 格式

```javascript
// 一般資訊
log.info("Chat Proxy running on http://127.0.0.1:3456");
// 輸出: [proxy] INFO  Chat Proxy running on http://127.0.0.1:3456

// 警告
log.warn("上游回傳空內容，嘗試降級重試");
// 輸出: [proxy] WARN  上游回傳空內容，嘗試降級重試

// 錯誤
log.error("串流直通失敗:", "connection reset");
// 輸出: [proxy] ERROR 串流直通失敗: connection reset

// 系統錯誤（最高優先級）
log.sysError("上游模型 qwen3.6-27b 傳回空白，已是最低等級無法降級");
// 輸出: [系統] [系統錯誤] 上游模型 qwen3.6-27b 傳回空白...
```

---

## 5. 環境變數控制

| 變數              | 值                                 | 效果                           |
| ----------------- | ---------------------------------- | ------------------------------ |
| `PROXY_LOG_LEVEL` | `silent\|error\|warn\|info\|debug` | 控制輸出層級（預設 warn）      |
| `FORCE_COLOR`     | `1\|true`                          | 強制啟用色彩（CI/無 TTY 環境） |
| `NO_COLOR`        | `1\|true`                          | 強制禁用色彩                   |
| `TERM`            | `xterm-256color` 等                | 自動偵測終端機能力             |

### 測試指令

```bash
# 正常環境（有 TTY）
bun your-module.js

# 強制色彩（CI/CD、背景執行）
FORCE_COLOR=1 bun your-module.js

# 禁用色彩（日誌檔案、管道輸出）
NO_COLOR=1 bun your-module.js

# 除錯模式
PROXY_LOG_LEVEL=debug FORCE_COLOR=1 bun your-module.js
```

---

## 6. 已整合模組清單（2026-07-02 基準）

| 檔案                          | 標籤           | 狀態 | 備註                    |
| ----------------------------- | -------------- | ---- | ----------------------- |
| `src/chat-proxy.js`           | `proxy`        | ✅   | 核心 Proxy，含 sysError |
| `src/start-proxy.js`          | `proxy`        | ✅   | 啟動器                  |
| `src/index.js`                | `plugin`       | ✅   | 插件主入口              |
| `src/provider/router.js`      | `router`       | ✅   | 多 Provider 路由        |
| `src/self-learning-plugin.js` | `learning`     | ✅   | 學習插件                |
| `src/evolution-engine.js`     | `evolution`    | ✅   | 進化引擎                |
| `src/provider/auth/index.js`  | `auth`         | ✅   | Auth 工廠               |
| `src/provider/auth/oauth.js`  | `auth:oauth`   | ✅   | OAuth 認證              |
| `src/provider/auth/cookie.js` | `auth:cookie`  | ✅   | Cookie 認證             |
| `src/provider/index.js`       | `provider`     | ✅   | Provider 匯出           |
| `src/provider/provider.js`    | `provider`     | ✅   | Provider 基類           |
| `src/auto-judge.js`           | `auto-judge`   | ✅   | 自動判斷                |
| `src/hardware-detect-cli.js`  | `hardware`     | ✅   | 硬體偵測 CLI            |
| `src/resolve-deps.mjs`        | `resolve-deps` | ⚠️   | 部分統一（保留原格式）  |

---

## 7. 驗收標準

### 7.1 功能驗收

- [ ] `FORCE_COLOR=1` 環境下，所有 log 輸出帶有 ANSI 色碼
- [ ] `NO_COLOR=1` 環境下，所有 log 輸出為純文字（無 ANSI）
- [ ] `[系統錯誤]` 顯示為**粗體紅色**（`\x1b[1m\x1b[38;2;224;108;117m`）
- [ ] 各模組標籤顯示正確專屬色彩
- [ ] `PROXY_LOG_LEVEL` 正確過濾輸出層級

### 7.2 程式碼驗收

- [ ] 所有模組引入 `color.js` 而非自行定義色彩
- [ ] 無硬編碼 `\x1b[31m` 等 ANSI 碼
- [ ] 使用 `c.tag()`、`c.level()`、`c.error()` 等語義函式
- [ ] 系統級錯誤使用 `log.sysError()` 而非 `log.error()`

### 7.3 文件同步

- [ ] `ARCHITECTURE.md` 變更紀錄表更新
- [ ] `AGENTS.md` 色彩系統章節更新
- [ ] `TROUBLESHOOT.md` 終端機色彩系統章節更新
- [ ] `VERSION_SOP.md` 版本號遞增
- [ ] `MILESTONES.md` / `ROADMAP.md` 里程碑更新
- [ ] `README.md` 環境變數說明更新

---

## 8. 常見問題與排除

| 問題              | 原因                           | 解決                                     |
| ----------------- | ------------------------------ | ---------------------------------------- |
| 色彩不顯示        | 非 TTY 環境                    | 加 `FORCE_COLOR=1`                       |
| 色彩亂碼          | 終端機不支援 TrueColor         | 設 `TERM=xterm-256color` 或 `NO_COLOR=1` |
| `[系統錯誤]` 不紅 | 未使用 `c.bold(c.error())`     | 改用 `log.sysError()`                    |
| 標籤顏色錯誤      | TAG_COLOR 表未定義             | 在 `color.js` 的 `TAG_COLOR` 新增對應    |
| 雙重色碼          | 同時使用舊 ESC 物件與 color.js | 移除舊 ESC 定義，統一用 color.js         |

---

## 9. 變更管理

| 版本 | 日期       | 變更內容                       | 變更人       |
| ---- | ---------- | ------------------------------ | ------------ |
| 1.0  | 2026-07-02 | 初版建立，涵蓋 13 模組整合標準 | AI Assistant |

> **修改本 SOP 時，必須同步更新**：
>
> 1. `VERSION_SOP.md` 版本記錄
> 2. 知識庫（`knowledge-autosave --wiki`）
> 3. 相關模組若有破壞性變更

---

## 10. 相關資源

- 核心模組：`qwen2api-plugin/src/color.js`
- 架構文件：`ARCHITECTURE.md` §變更紀錄
- 專案規範：`AGENTS.md` §統一色彩系統
- 故障手冊：`TROUBLESHOOT.md` §終端機色彩系統
- 版本追蹤：`VERSION_SOP.md` §版本記錄
