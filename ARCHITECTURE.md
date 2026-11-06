# Qwen2API 系統架構

> 版本：2026-06-30 | 變體：dev（主要開發線）
>
> /home/reamaster/opencode-manager/projects/independent/qwen2api-main 可查看 原始碼 追碩修改過什麼
> /home/reamaster/opencode-manager/projects/independent/qwen2api-main/Qwen2API-更新包

## 概述

Qwen2API 是千問模型的本地 API 代理系統，提供 OpenAI 相容的聊天完成端點，
支援工具呼叫（MCP）、模型路由、自我學習、自動路由演化等進階功能。

---

## 子專案

| 子專案                   | 埠   | 入口                 | 功能                                         |
| ------------------------ | ---- | -------------------- | -------------------------------------------- |
| `qwen2api`               | 3000 | `src/start.js`       | 將 chat.qwen.ai 轉換為 OpenAI 相容 API       |
| `qwen2api-plugin`        | 3456 | `src/start-proxy.js` | 請求路由、tool_calls、自我學習（chat-proxy） |
| `telegram-memory-bridge` | 4377 | `src/index.ts`       | Telegram Bot + 跨機記憶/知識橋接             |
| `knowledge-wiki-plugin`  | —    | `src/index.ts`       | 知識庫/維基/教訓 OpenCode 插件               |

## 目錄結構

```
qwen2api-dev/
├── qwen2api/                          # 核心服務（port 3000）
│   ├── src/server.js                  # Express 主服務
│   ├── src/controllers/chat.js        # SSE 串流處理
│   ├── src/controllers/models.js      # 模型列表
│   ├── src/config/index.js            # 設定
│   ├── src/utils/
│   │   ├── chrome-fetch.js            # Chrome Fetch Proxy（WAF 繞過）
│   │   ├── request.js                 # 上游請求（重試+帳戶輪換）
│   │   ├── data-persistence.js        # 持久化設定
│   │   └── ssxmod-manager.js          # Cookie 管理器
│   ├── src/routes/                    # 路由：chat.js, models.js, health.js 等
│   └── start.sh / start.js            # 啟動腳本
├── qwen2api-plugin/                   # opencode 插件 + chat-proxy
│   ├── src/chat-proxy.js              # 聊天代理（port 3456，1836 行）
│   ├── src/index.js                   # 插件入口（14 個工具）
│   ├── src/start-proxy.js             # Proxy 啟動器（重試 + keepalive）
│   ├── src/evolution-engine.js        # evolution-engine.js（自動權重/路由調整）
│   ├── src/self-learning.js           # 自我學習系統
│   ├── src/auto-judge.js              # 經驗自動判斷
│   ├── src/hardware-detect.js         # 硬體偵測
│   ├── src/platform.js                # 跨平台工具（killPort, execShell 等）
│   └── src/resolve-deps.mjs           # 共享依賴自動修復
├── telegram-memory-bridge/            # Telegram Bot + 記憶/知識橋接
│   ├── src/index.ts                   # Bot 主入口（port 4377）
│   ├── src/store.ts                   # 記憶儲存層
│   ├── src/sync-cli.ts               # 同步 CLI
│   ├── tools/                         # 工具腳本（generate-key, encrypt-env）
│   └── test/                          # 測試
├── knowledge-wiki-plugin/             # 知識庫/維基/教訓插件
│   ├── src/index.ts                   # 插件主入口
│   ├── src/tools.ts                   # 工具註冊
│   ├── src/provider/                  # Provider 實現
│   ├── src/provider-manager.ts        # Provider 管理器
│   ├── src/types/                     # 型別定義
│   ├── SKILL.md                       # 技能說明
│   └── openclaw.plugin.json           # 插件元數據
├── config/
│   ├── paths.js                       # 跨裝置路徑集中管理
│   └── index.js / manager.js          # 配置管理（在 qwen2api-plugin/src/config/）
├── start.mjs                          # 統一啟動器（902 行，核心）- 管理全部服務生命週期
├── start.sh                           # 一鍵啟動 wrapper → 委派 start.mjs（全服務）
├── config.json                        # 服務定義（供外部工具解析）
├── .env                               # 環境變數
├── .ai-variant                        # AI 變體辨識
├── .gitignore
├── refresh-token.js                   # Token 自動更新腳本
├── tailscale.sh                       # Tailscale 安裝腳本
├── sync-to-desktop.sh                 # 筆電→桌機檔案同步
├── test_stall.sh                      # 停頓診斷腳本
├── ARCHITECTURE.md / AGENTS.md        # 架構/規範文件
├── MILESTONES.md / ROADMAP.md         # 里程碑/路線圖
├── VERSION_SOP.md                     # 版本 SOP
├── TROUBLESHOOT.md                    # 滯留訊息修復手冊
├── README.md / .opencode/lesson-learned/  # 說明 / 教訓快取
└── logs/                              # 運行日誌（run-{timestamp}/）
```

## 通訊架構

> ⚠️ **重要：所有模型服務都是本機代理，不對外提供連接。**
>
> | 服務                   | 綁定        | 對外       | 說明                                          |
> | ---------------------- | ----------- | ---------- | --------------------------------------------- |
> | qwen2api (3000)        | `127.0.0.1` | ❌         | 本機 API 代理，轉發至 Qwen 雲端               |
> | chat-proxy (3456)      | `127.0.0.1` | ❌         | 本機路由/工具/自我學習                        |
> | telegram-bridge (4377) | `0.0.0.0`   | ✅ Tailnet | **唯一對外**：主機暴露 API，節點推送→主機拉取 |
>
> **跨裝置 ≠ 跨裝置連線**。跨裝置是指「本機路徑依 Linux/Win/Mac 自動切換」。
> Telegram Bot 的節點/主機架構是 Tailnet VPN 內的推送-拉取模式，非一般對外服務。

```
opencode (AI)
    │
    ├── /v1/chat/completions ──→ chat-proxy (127.0.0.1:3456) ──→ qwen2api (127.0.0.1:3000) ──→ Qwen API
    │                                │
    └── 工具呼叫 (MCP) ─────────→ chat-proxy (127.0.0.1:3456)
                                     │
                                     ├── read/write/edit/glob/grep/bash （本地執行）
                                     └── skill/wiki/memory （本地查詢）
```

## 核心流程

1. opencode 發送 `/v1/chat/completions` 至 proxy（3456）
2. proxy 分析任務複雜度，路由至合適模型
3. proxy 注入 tool-prompt，轉發至 qwen2api（3000）
4. qwen2api 呼叫上游 Qwen API
5. proxy 接收回應：
   - tool_calls → 透傳給 opencode 執行
   - bash block → 轉換為 tool_calls
   - 純文字 → 直接回傳
6. 異常時自動降級（Direct 模式）

---

---

## 啟動流程（start.sh → start.mjs）

> `start.sh`（一鍵啟動）與 `bun run dev` 皆委派給 `start.mjs`，後者為核心統一啟動器。

統一啟動器 `start.mjs` 為核心入口，負責所有服務生命週期管理。

### 啟動順序

```
start.mjs
  │
  ├── 1. 前置檢查
  │     ├── node_modules 存在性（qwen2api + qwen2api-plugin）
  │     ├── .env 存在（根目錄或 qwen2api/.env）
  │     └── bun 可用性
  │
  ├── 2. .env 自動載入（根目錄 → qwen2api/ → telegram-memory-bridge/）
  │
  ├── 3. 殺舊進程
  │     ├── killOldParent()：讀 PID 檔殺舊 start.js
  │     └── Chrome 孤兒掃描：`grep chrome.*chrome-qwen-profile`
  │
  ├── 4. 埠衝突檢查（resolvePortConflicts）
  │     ├── alive=埠有健康服務 → 跳過啟動
  │     ├── free=埠空著 → 啟動新服務
  │     └── dead=埠佔用但無回應 → 阻塞並提示手動殺
  │
  ├── 5. 寫 PID 檔（/tmp/qwen2api-dev.pid）
  │
  ├── 6. 清理舊日誌（logs/run-*）
  │
  ├── 7. 依序啟動服務（waitFor 健康檢查）
  │     ├── qwen2api（port 3000）→ 最多等 30s，失敗可重試一次
  │     ├── chat-proxy（port 3456）→ 最多等 15s，失敗不阻塞
  │     └── telegram-bridge（port 4377）→ 需 TELEGRAM_BOT_TOKEN 才啟動
  │
  └── 8. 健康報告輸出 + 裝置資訊
```

### 埠策略原則

| 狀態    | 含義           | 行為                 |
| ------- | -------------- | -------------------- |
| `free`  | 埠空著         | 啟動服務             |
| `alive` | 埠有健康服務   | 跳過（不殺）         |
| `dead`  | 埠佔用但無回應 | 阻斷啟動，提示手動殺 |

> **永不主動殺 systemd / PM2 / 其它專案服務。** 只透過 PID 檔追蹤自身子進程。

### Chrome 孤兒進程清理

- 啟動前 `ps aux | grep chrome.*chrome-qwen-profile` 掃描
- 只殺 `.chrome-qwen-profile` 的 Chrome（qwen2api 專屬），不誤殺系統 Chrome
- server.js `process.on("exit")` 確保退出時殺 Chrome

---

## config.json 服務定義

`config.json` 為機器可讀的服務清單，供外部工具或 IDE 使用：

| 服務              | 埠   | 命令                     | 健康檢查 URL                       |
| ----------------- | ---- | ------------------------ | ---------------------------------- |
| `qwen2api`        | 3000 | `bun src/start.js`       | `http://127.0.0.1:3000/health`     |
| `chat-proxy`      | 3456 | `bun src/start-proxy.js` | `http://127.0.0.1:3456/health`     |
| `telegram-bridge` | 4377 | `bun src/index.ts`       | `http://127.0.0.1:4377/api/health` |

---

## 雙機架構

本系統支援跨機器部署（筆電 ↔ 桌機），透過 Tailscale VPN 連線。

> ⚠️ **注意**：每台機器的 qwen2api / chat-proxy 都是**本機代理**（綁 `127.0.0.1`），不對外。
> 跨機器通訊**僅限 Telegram Bot**：主機暴露 API (4377)，節點推送→主機拉取。

| 機器               | 角色        | 資源     | 運行服務                               | 綁定                      |
| ------------------ | ----------- | -------- | -------------------------------------- | ------------------------- |
| **筆電**（開發端） | 🟡 輕量節點 | 性能較差 | qwen2api + chat-proxy（不跑 bot/監視） | 127.0.0.1                 |
| **桌機**（主機）   | 🟢 Master   | 資源充足 | qwen2api + chat-proxy + bot + watcher  | 127.0.0.1 + 0.0.0.0 (bot) |

### 環境變數

| 變數                 | 值              | 說明                         |
| -------------------- | --------------- | ---------------------------- |
| `TAILSCALE_WATCH`    | `off`           | 筆電模式跳過 tailscale 輪詢  |
| `MASTER_IP`          | `100.71.40.106` | 筆電固定連線桌機 IP          |
| `TELEGRAM_BOT_TOKEN` | (Token)         | 有設定才啟動 telegram-bridge |

### 同步機制（sync-to-desktop.sh）

```
筆電(Linux) ──tar pipe SSH──→ 桌機(Windows PowerShell)
```

- 單次 tar pipe 連線，只問一次密碼
- 支援 `--dry-run` 預覽
- 同步清單包含：store.ts / index.js / provider.js / router.js / paths.js 等
- 跨平台：Linux `tar` → SSH → Windows `tar -xzf`

---

## Token 自動刷新（refresh-token.js）

`refresh-token.js` 為跨平台 Token 更新腳本，透過 Puppeteer 模擬登入刷新 token。

| 屬性     | 值                                                 |
| -------- | -------------------------------------------------- |
| 安全 ID  | `opencode-qwen2api-dev / token-refresh`            |
| 調用腳本 | `qwen2api/auto-get-token.js`                       |
| 日誌位置 | `logs/refresh-token-{日期}.log`                    |
| 排程方式 | Linux: crontab 每 6h / Windows: 工作排程器         |
| 模式     | `--once` 單次執行；無參數等 30s 後退出（供排程用） |

---

## Provider 路由與自動切換

### 模式

- **proxy mode**（預設）：所有請求經過 chat-proxy（3456），支援 MCP 工具
- **direct mode**（降級）：Proxy 連續 3 次失敗（`PROXY_FAIL_THRESHOLD=3`）自動切換，工具不可用但聊天仍正常
- **恢復**：監控循環每 30s 檢查 proxy，恢復後自動切回

### 多 Provider 路由

| Provider    | 說明                 | 優先級 |
| ----------- | -------------------- | ------ |
| qwen2api    | Direct 呼叫 Qwen API | 高     |
| qwen-proxy  | 經由 Proxy 轉發      | 中     |
| Codex Cloud | 雲端備援             | 低     |

### 策略

- `adaptive`（預設）：依即時延遲與失敗次數動態選擇最佳 Provider
- `failover`：固定順序，依序嘗試

### 斷路器（Circuit Breaker）

| 屬性 | 值                                            |
| ---- | --------------------------------------------- |
| 閾值 | 連續 5 次失敗                                 |
| 冷卻 | 30 秒                                         |
| 半開 | 冷卻後自動嘗試一次                            |
| 位置 | `qwen2api-plugin/src/index.js` `circuitState` |

---

## 插件工具清單

`qwen2api-plugin/src/index.js` 註冊 17 個工具（透過 @opencode-ai/plugin）：

| 工具                 | 功能                 | 底層 MCP                |
| -------------------- | -------------------- | ----------------------- |
| `qwen_read`          | 讀取檔案             | `read`                  |
| `qwen_write`         | 寫入檔案             | `write`                 |
| `qwen_edit`          | 編輯檔案（尋找取代） | `edit`                  |
| `qwen_glob`          | 搜尋檔案             | `glob`                  |
| `qwen_grep`          | 內容搜尋             | `grep`                  |
| `qwen_bash`          | 執行 shell 命令      | `bash`                  |
| `qwen_skill_list`    | 列出技能清單         | `skill_list`            |
| `qwen_skill_read`    | 讀取技能內容         | `skill_read`            |
| `qwen_wiki_search`   | 搜尋維基/知識庫      | `wiki_search`           |
| `qwen_wiki_read`     | 讀取維基頁面         | `wiki_read`             |
| `qwen_memory`        | 查詢記憶系統         | `memory_query`          |
| `qwen_health`        | 服務健康狀態         | `GET /health`           |
| `qwen_repair`        | 自我修復             | `POST /health/repair`   |
| `qwen_token`         | Token 狀態檢查       | `GET /health`           |
| `qwen_diagnose`      | 完整診斷             | `POST /repair/diagnose` |
| `qwen_proxy_status`  | Proxy 狀態           | `GET /health` (proxy)   |
| `qwen_repair_manual` | 維修手冊查詢         | `GET /repair/manual`    |

---

## 自我學習 SIP 協議

模型在完成任務後可自動調用 `self_*` 工具記錄經驗：

| 情境             | 信心指數 | 行動                                 |
| ---------------- | -------- | ------------------------------------ |
| Bug 修復成功     | ≥ 0.85   | `self_record_feedback` + Lesson 記錄 |
| 新功能開發完成   | ≥ 0.8    | `self_record_feedback`               |
| 程式碼分析完成   | ≥ 0.7    | `self_learn_code_style`              |
| 學到全新技術概念 | ≥ 0.75   | 自動判斷是否建立 Wiki/Knowledge      |

---

## 監控系統

| 項目        | 間隔   | 說明                                  |
| ----------- | ------ | ------------------------------------- |
| 健康監控    | 30s    | qwen2api + proxy 雙重檢查（插件內）   |
| Chrome 健康 | 60s    | chrome-fetch 自我健康檢查 + 自動恢復  |
| 進化引擎    | 1h     | 模型權重調整、停滯分析                |
| 斷路器      | 即時   | 連續 5 次失敗開啟，30s 半開           |
| 模型穩定性  | 啟動後 | `probeModelStability()` 推理測試      |
| 健康報告    | 啟動後 | `generateHealthReport()` 產出服務概覽 |

## 環境變數

| 變數                 | 預設                  | 說明                                     |
| -------------------- | --------------------- | ---------------------------------------- |
| `QWEN2API_PORT`      | 3000                  | qwen2api 端口                            |
| `QWEN2API_KEY`       | sk-qwen2api-test-2026 | API 金鑰                                 |
| `PROXY_PORT`         | 3456                  | Proxy 端口                               |
| `PROXY_TIMEOUT_MS`   | 120000                | 總請求超時（ms）                         |
| `PROXY_GRACE_MS`     | 8000                  | 啟動寬容期（ms）                         |
| `PROXY_RATE_LIMIT`   | 600                   | 每分鐘請求上限                           |
| `PROXY_LOG_LEVEL`    | warn                  | 日誌等級（silent/error/warn/info/debug） |
| `TAILSCALE_WATCH`    | —                     | 跳過 Tailscale 輪詢                      |
| `MASTER_IP`          | —                     | 雙機主機 IP                              |
| `TELEGRAM_BOT_TOKEN` | —                     | Telegram Bot Token                       |
| `AUTH_DISABLED`      | true                  | 關閉 API Key 驗證（開發用）              |
| `LIGHTWEIGHT`        | true                  | Chrome `--single-process`                |
| `API_RATE_LIMIT`     | 600                   | 服務端每分鐘請求上限                     |
| `DEVICE_ROLE`        | auto                  | 裝置角色（laptop/desktop）               |

---

## 跨裝置路徑集中管理

> ⚠️ **跨裝置 = 本機執行路徑依當前裝置自動切換（Linux/Win/Mac），不是網路連線、不是對外服務。**
> **所有模型服務（qwen2api:3000、chat-proxy:3456）都是本機代理，綁 `127.0.0.1`，不對外。**
> **唯一對外 = Telegram Bot（主機 4377 Tailnet API，節點推送→主機拉取）。**

`config/paths.js` 為路徑單一真相來源，所有檔案從此引入：

| 變數              | Linux 路徑                                                       | Windows 路徑                   |
| ----------------- | ---------------------------------------------------------------- | ------------------------------ |
| `ROOT`            | `$HOME/opencode-manager`（`homedir()` 動態取得）                 | `D:\opencode\opencode-manager` |
| `OPENCODE_DIR`    | `$ROOT/projects/.opencode`                                       | 同上（自動切換分隔符）         |
| `QWEN2API_DIR`    | `$ROOT/projects/independent/qwen2api-dev/qwen2api`               | 同上                           |
| `TELEGRAM_BRIDGE` | `$ROOT/projects/independent/qwen2api-dev/telegram-memory-bridge` | 同上                           |
| `KNOWLEDGE_WIKI`  | `$ROOT/projects/independent/qwen2api-dev/knowledge-wiki-plugin`  | 同上                           |
| `SYSTEM_DIR`      | `$ROOT/projects/system/packages/opencode`                        | 同上                           |

> ROOT 依 `os.homedir()` 動態取得，不再硬編碼 `/home/reamaster`。可透過 `PROJECT_ROOT` 環境變數覆寫。

---

## 跨裝置模型定義統一管理

`config/models.js` 為模型定義單一事實來源（2026-07-04 新增），確保雙機模型路由一致。

### 裝置感知

| 角色      | 觸發條件                                   | 模型策略                                        |
| --------- | ------------------------------------------ | ----------------------------------------------- |
| `desktop` | 無電池 / 環境變數 `DEVICE_ROLE=desktop`    | 不預設封鎖任何模型，由 runtime 健康檢查動態管理 |
| `laptop`  | 偵測到電池 / 環境變數 `DEVICE_ROLE=laptop` | 封鎖 qwen3.7 全系列（i5-5200U 無法負擔）        |

### 跨裝置模型預設值

| 等級     | 桌機（高效能）          | 筆電（保守）            |
| -------- | ----------------------- | ----------------------- |
| `small`  | `qwen3.6-27b`           | `qwen3.6-27b`           |
| `medium` | `qwen3.6-plus-thinking` | `qwen3.6-27b`           |
| `large`  | `qwen3.6-max-preview`   | `qwen3.6-plus-thinking` |

> 環境變數 `PROXY_SMALL_MODEL`、`PROXY_MEDIUM_MODEL`、`PROXY_LARGE_MODEL` 可強制覆寫。

### 關鍵行為：top-tier 不降級

當當前模型為最上層模型（如 `qwen3.6-max-preview`）且回傳空內容時：

- ❌ **不降級**到 weaker 模型（plus/27b），因為最聰明的模型都做不到的事，更弱的模型更不可能
- ✅ **僅嘗試**同級備用模型或同模型重試一次
- 避免 `qwen3.6-max-preview → qwen3.6-plus → qwen3.6-27b` 的無意義降級鏈

---

## 診斷工具

| 工具                | 用途                                                   | 用法                 |
| ------------------- | ------------------------------------------------------ | -------------------- |
| `test_stall.sh`     | 精確測量各階段耗時（模型列表、純文字、含 tools、串流） | `bash test_stall.sh` |
| `TROUBLESHOOT.md`   | 滯留訊息快速診斷流程（§A-§Z）                          | 依症狀查表           |
| `qwen_diagnose`     | 工具內建完整診斷，檢查所有已知問題                     | 對話中呼叫           |
| `curl :3000/health` | 快速確認 qwen2api 狀態                                 | 手動檢查             |
| `curl :3456/health` | 快速確認 proxy 狀態                                    | 手動檢查             |

---

## 目前狀態（2026-07-12 最後診斷）

> 新進 AI 先讀這節，快速掌握專案狀況。

### 對話中斷根因與對策（核心問題）

> 「對話忽然停止 / 空白 / 卡工作中」是本系統最復發的症狀，根因可分四層，依發生頻率排列：

| 層級 | 根因                                         | 觸發症狀                              | 現有對策（已實作）                                                                       |
| ---- | -------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | 上游 WAF（Aliyun baxia）全域空內容           | 模型回傳空、proxy 跳重試、對話框停滯  | 空內容風暴 timeout 動態縮短、top-tier 不降級、error 只進終端機、SSE idle 逾時送 `[DONE]` |
| 2    | DashScope 403 / 帶金鑰模型不可用             | `qwen-flash/plus` 連續 403 降級至 max | 斷路器標記不可用、跳過、降級 Chrome/axios 路徑                                           |
| 3    | Chrome Fetch 逾時 / SSE 黑洞（WAF 雙重校驗） | `createChat 逾時`、SSE 降級略過       | WAF 模式加速、階梯式斷路器恢復、請求 lazy 重啟                                           |
| 4    | proxy 連續 3 次失敗 → 自動切 Direct 模式     | MCP 工具失效，僅聊天可用              | 監控 30s 自動切回；Direct 模式下 `qwen_health/qwen_proxy_status` 仍可用                  |

**預防優先順序**：設定 `DASHSCOPE_API_KEY` 走官方 API 可同時消除第 1、2、3 層（繞過 WAF），是最徹底的解法。

**實測確認（2026-07-09）**：金鑰 `qwen-max` 可用且穩定（繞過 WAF），但 `qwen-plus`/`qwen-flash` 免費額度已耗盡（`insufficient_quota`）。原先 `_dsUnavailableModels` 為永久 Set，一旦 plus/flash 403 就永久封鎖，且 DashScope 路徑優先於 WAF 路徑 → 整條鏈失效 → 對話忽然停止。已修復（Fix 35）：TTL 5min 自動恢復 + `qwen-max` 掃描優先，現在任何層級請求都會自動提升到可用的 `qwen-max`。

**已修復的 code bug（會直接造成中斷）**：

- `platform.js`: `execShellAsync` 的 `finish`/`catch` 參考未宣告的 `timer`（實際變數為 `_timer`），**每次執行 bash 工具都拋 `timer is not defined`**，但被 keepalive 吞掉 → 對話看似卡住。已提升 `_timer` 宣告作用域並統一引用（2026-07-09）。

### 服務健康度

| 服務            | 埠口 | 狀態    | 備註                           |
| --------------- | ---- | ------- | ------------------------------ |
| qwen2api        | 3000 | ✅ 健康 | 上游 Qwen API 代理             |
| chat-proxy      | 3456 | ✅ 健康 | 工具呼叫 + 模型路由 + 自我學習 |
| telegram-bridge | 4377 | ✅ 健康 | peer mode, 67 筆記憶           |

### 最近修復（這次對話完成的）

1. **錯誤訊息不再滯留對話框** — `buildErrorResponse` 暫態錯誤設 `content: null`，串流錯誤送提示 chunk 再 `[DONE]`
2. **非 bash 程式碼區塊自動轉寫檔** — `bashBlockToToolCalls`（單一 pass）+ `extractFilename` + `normalizeHeredoc`，模型輸出 `jsx` 時自動轉 `cat heredoc` bash 命令，含 `mkdir -p` 自動建立目錄
3. **對話歷史壓縮** — 超過 40 則或工具結果 >6KB 自動壓縮，防止 context window 爆掉
4. **自動記錄判斷框架** — 依任務與規則自動決定是否記錄、記錄什麼、記在哪（不再需要使用者提醒；不代表有獨立意志）
5. **進化引擎自動同步黑名單** — `evolve()` 偵測到高停滯/超時模型後，自動推入 `globalThis.__opencode_model_blacklist__`，路由層直接跳過
6. **全域工具呼叫硬上限** — `MAX_GLOBAL_TOOL_CALLS=20`，超過強制轉為文字回應，防止模型無限迴圈
7. **`suggestFallbackRoute` 回傳全部壞模型** — 不再只回傳第一個，改為陣列回傳所有不健康模型
8. **根治 content:null 滯留訊息** — response builders 改為完全省略 content 鍵（而非設為 null），streaming error path 不再送錯誤 chunk，reasoning_content 串流不送空 content
9. **跨裝置模型定義一致性** — 新增 `config/models.js` 統一管理模型預設值與黑名單，筆電/桌機自動切換；top-tier 模型（max-preview）不再降級到較弱模型
10. **BASE_TIMEOUT 提升（75s→120s）** — 大型多檔案生成任務不再因超時中斷
11. **認知關鍵詞擴充** — 新增 fix/repair/debug/diagnose 等修復關鍵詞，修復任務路由到合適模型
12. **智能微調持久化** — `intelligent-tuning.js` 行為數據存檔 `~/.opencode/tuning/tuning-data.json`，進程重啟不遺失
13. **Chrome 崩潰串流保護** — disconnected 事件自動銷毀所有 active streams，防止串流卡死
14. **ERROR 日誌永不靜默** — logger ERROR 級別永久輸出 stderr（與 SSE stdout 隔離）
15. **pipeUpstream 閒置超時銷毀** — idle timeout 時 destroy 上游串流 + removeAllListeners，防止 Promise 懸而未決
16. **headersSent 保護** — 串流/非串流 path 皆檢查 `res.headersSent`，防止串流開始後誤送 status 500
17. **空內容備用循環 3 次上限** — `MAX_EMPTY_RETRY=3`，日誌顯示進度 `[1/3]`，避免 12 個備用模型逐一嘗試浪費 12 秒
18. **空內容專用失效門檻** — `EMPTY_CONTENT_FAIL_THRESHOLD=2`，連續 2 次空內容直接跳過備用循環
19. **模型健康數據持久化** — `saveModelHealth()`/`loadModelHealth()`，5 分鐘自動儲存，啟動時載入
20. **Chrome Fetch 斷路器永久禁用** — 冷卻達 maxCooldown(5min) 且連續失敗 ≥6 次 → `_permanentDisabled=true`，不再浪費資源重試
21. **write 工具自動建立目錄** — `mkdirSync(dir, {recursive: true})`，模型在不存在目錄建立檔案不再靜默失敗，並備援降級 `fs.writeFileSync`
22. **非 bash 程式碼區塊自動轉 write tool_calls** — 支援 40+ 種語言副檔名，從註解/前方文字推斷檔案路徑，自動注入 write tool_calls
23. **Telegram Bot 記憶儲存邏輯改善** — 分類失敗(cls===null)且內容 ≥80 字仍儲存為 fact；store=false 但內容 ≥300 字以低重要性儲存
24. **`os` import 修正** — chat-proxy.js 補上 `import os from "node:os"`，解決 model-health 持久化拋錯
25. **bash 超時 30s→60s + cwd 支援** — execShellAsync 超時提升至 60000ms，支援 args.cwd 參數
26. **空內容重試停滯根治 (v6)** — 重試迴圈對「空內容「或」逾時/錯誤」都計數，首敗即跳（原只計空內容導致 5 候選全跑 25s 卡死）
27. **錯誤可複製 (v6)** — `buildErrorResponse` content 從 `""` 改為 `⚠️ {msg}`，錯誤文字進對話框可複製（保留 terminal log）
28. **Chrome timeout 加速 (v6)** — WAF 模式閾值 2→1 次，正常 15s→10s / WAF 8s；備用路徑 25s→15s / 12s→8s，首次阻擋即加速失敗感知
29. **失敗續作／禁止反問（2026-11-05）** — `tool-prompt.js` buildToolSystemPrompt Rules + `chat-proxy.js` CAPABILITY_DEF 新增「工具失敗換方法繼續／不要詢問確認／禁止反問結尾」硬規則，根治模型遇第一個工具錯誤即停機反問（光說不做事）
30. **捏造 `<tool_response>` 清洗（2026-11-05）** — `stripFabricatedToolResponses()` 統一移除 assistant content 內假工具結果（含未閉合尾端）；stream passthrough 不套（邊界跨 chunk），靠 prompt 事實句抑制

### 已知問題

| 問題                        | 狀態      | 說明                                                                        |
| --------------------------- | --------- | --------------------------------------------------------------------------- |
| 某些模型高超時率            | ⚠️ 未修復 | qwen3.6-plus-thinking ~50%（evolution-engine 會自動路由降級）               |
| Telegram bot 無 Token 模式  | ✅ 已處理 | 已支援節點模式，不綁 Token 亦可啟動                                         |
| `process.stderr.write` 殘留 | ✅ 已修復 | processor.ts/prompt.ts 已清理                                               |
| Chrome 孤兒進程             | ✅ 已修復 | exit handler + 啟動前孤兒掃描                                               |
| `timer is not defined`      | ✅ 已修復 | platform.js `execShellAsync` 引用未宣告變數，每 bash 指令拋錯（2026-07-09） |
| qwen3.7-plus 長 prompt 空內容 | ⚠️ 未修復 | 修復任務型 prompt（3.2KB+）間歇 `upstream_502 upstream_empty_content`（2026-11-05 兩次實證）；預設維持 qwen3.8-omni-flash，勿設 Qwen3.7-Plus 為預設 |
| 免額 access token 15 分鐘效期 | ⚠️ 須手動 | refresh 端點上游封成 405（2026-11-05 實證），逾期免額全滅；需手動 localStorage `token` 注入 `/api/injectCookies`，cookies 不含 token；永續解＝DASHSCOPE_API_KEY + DASHSCOPE_ALLOW_FALLBACK=true（百煉付費） |
| `write after end` 未捕獲異常（WAF 503 後 2 秒內） | ✅ 已修復 | keepalive raw `res.write`（write-after-end 為非同步 error 事件，try/catch 攔不住）+ `res` 無 `on('error')` + `safeWrite`/`safeEnd` 未查 `writableEnded` + SSE headersSent 後 WAF/一般錯誤皆不收尾（client 掛死、殘缺串流存檔）。修復：全部改 `safeWrite`/`_safeResWrite`、兩處 pipeUpstream 掛 `on('error')`、4 個 catch 補 SSE error 幀+`[DONE]`、browser-proxy/anthropic/cli.chat/chat.image.video 同類補守衛（2026-11-05 Fix 47-52） |

### 不變邊界（絕對不要改）

> ⚠️ **跨裝置核心規則**：跨裝置 = 本機路徑依 Linux/Win/Mac 自動切換，不是網路連線。所有模型服務綁 `127.0.0.1`（本機），唯一對外是 Telegram Bot (4377)。

| 邊界                                 | 理由                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `chrome-fetch.js` headless: false    | WAF 繞過需要                                                        |
| `start.mjs` 非同步啟動               | 埠管理 + 子進程監控需非同步                                         |
| `chat-proxy.js` 不 process.exit()    | 異常時應 keepalive 重試                                             |
| 資料只存 `projects/.opencode/`       | 🔥 system/ 翻車即刪                                                 |
| `start.mjs` 🚫 LOCKED 輸出區塊       | 啟動界面鎖定（詳見 AGENTS.md → 啟動界面鎖定）                       |
| `buildErrorResponse` content:""      | 🔥 絕對禁止省略 content key，否則對話框空白                         |
| `_lastGlobalEmptyAt.ts` 先計算再更新 | 🔥 ts 更新順序錯誤導致風暴計數永遠遞增                              |
| `_cbRecordFail` 需傳遞 WAF 參數      | 🔥 區分 WAF 阻擋 vs 真實失敗，策略不同                              |
| 斷路器禁用後階梯式恢復               | 🔥 禁止固定 5min 鎖死，WAF 通常 1-2min 恢復                         |
| **禁止硬編碼路徑**                   | 🔥 禁止 `/home/reamaster` 等硬編碼，一律 `os.homedir()`             |
| **服務綁定**                         | 🔥 qwen2api/chat-proxy 綁 `127.0.0.1`，僅 Telegram Bot 綁 `0.0.0.0` |
| SSE 降級略過（signal.aborted/WAF）   | 🔥 signal 中止後不再重試 main page SSE，省 20s + 防雙重計數         |

---

## 修改追蹤清單（升級本源對照）

> 按檔案分組，記錄所有偏離上游源碼的變更。升級上游時逐條檢查是否需要重新套用。

### qwen2api-plugin/src/chat-proxy.js（主要修改集中區）

| 日期       | 修改內容                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 原因                                                                                                                                             | 是否可撤回                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 2026-07-02 | `buildErrorResponse`: 暫態錯誤回傳 content:null，永久錯誤才顯示提示                                                                                                                                                                                                                                                                                                                                                                                                       | 避免暫態超時錯誤滯留對話框，使用者不需看到「服務忙碌」等暫態訊息                                                                                 | ✅ 可安全撤回                               |
| 2026-07-02 | `buildToolPrompt`: 強化強制指令「不要說，直接做」+ 加入 cat heredoc 檔案建立範例                                                                                                                                                                                                                                                                                                                                                                                          | 模型偏好輸出描述句而非直接執行命令，導致任務停滯                                                                                                 | ✅ 可安全撤回                               |
| 2026-07-02 | `bashBlockToToolCalls`: 支援非 bash 程式碼區塊（jsx/tsx/py）自動轉 bash write 命令 + heredoc 正規化                                                                                                                                                                                                                                                                                                                                                                       | 模型輸出 ```jsx 等程式碼區塊時不會建立檔案，需自動轉換                                                                                           | ✅ 可安全撤回                               |
| 2026-07-02 | 對話歷史長度管理：超過 40 則或工具結果 >6KB 自動壓縮                                                                                                                                                                                                                                                                                                                                                                                                                      | 工具結果累積撐爆 context window，降低模型反應速度                                                                                                | ✅ 可安全撤回                               |
| 2026-07-02 | `recordModelFailure` / 空內容降級重試：上游回傳空白時自動嘗試備用模型                                                                                                                                                                                                                                                                                                                                                                                                     | 模型名稱不正確或暫時異常時自動恢復，不需使用者介入                                                                                               | ✅ 可安全撤回                               |
| 2026-07-02 | 串流模式錯誤處理：錯誤時送提示 chunk 再送 [DONE]                                                                                                                                                                                                                                                                                                                                                                                                                          | 避免串流靜默結束導致對話框顯示停滯                                                                                                               | ✅ 可安全撤回                               |
| 2026-07-03 | **根治 content:null 滯留**：response builders 改為省略 content 鍵（非設為 null）+ streaming path 跳過空內容                                                                                                                                                                                                                                                                                                                                                               | `JSON.stringify` 保留 `content: null`，opencode 仍顯示空氣泡                                                                                     | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 5: 移除背景模式暫態錯誤提示**：暫態錯誤一律不傳 content 欄位，不再區分 foreground/background                                                                                                                                                                                                                                                                                                                                                                        | background 模式 terminal 不可見時不讓錯誤訊息進對話框                                                                                            | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 6: bashBlockToToolCalls 單一 pass + 自動建立目錄**：合併 `codeBlockToBashCalls` 為單一掃描，維持區塊原始出現順序；非 bash 程式碼區塊自動補 `mkdir -p` 確保目錄存在                                                                                                                                                                                                                                                                                                  | bash 全部排在檔案寫入前面導致執行順序錯誤；無目錄時 cat 失敗中斷                                                                                 | ✅ 可安全撤回                               |
| 2026-07-04 | **跨裝置模型定義整合**：引入 `config/models.js` 取代硬編碼 `KNOWN_BAD_MODELS` 與 `getModelForLevel()` 預設值；`isQwen37Model` 改為裝置感知（筆電才封鎖）                                                                                                                                                                                                                                                                                                                  | 筆電/桌機需不同模型預設值，硬編碼無法跨裝置同步                                                                                                  | ⚠️ 需保留 config/models.js                  |
| 2026-07-04 | **top-tier 不降級**：empty content 重試時，`max-preview` 等最上層模型不再降級到 plus/27b，僅嘗試同級或同模型重試                                                                                                                                                                                                                                                                                                                                                          | 最強模型都無法回應時，降級到更弱模型毫無意義                                                                                                     | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 1: BASE_TIMEOUT 提升（75s→120s）**：`BASE_TIMEOUT` 改為 `120000`，智能微調層可動態調整                                                                                                                                                                                                                                                                                                                                                                              | 大型多檔案生成任務對 75s 不足，導致文件建立中斷                                                                                                  | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 2: 錯誤訊息僅輸出終端機**：`buildPermanentError` 改為 `buildErrorResponse`，錯誤訊息不再送入對話框                                                                                                                                                                                                                                                                                                                                                                  | 錯誤訊息不應顯示在對話框，使用者看不到 terminal 暫態錯誤                                                                                         | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 3: 認知關鍵詞擴充**：`COGNITIVE_KEYWORDS` 新增 fix/repair/debug/diagnose/troubleshoot/root/cause/heal/solve                                                                                                                                                                                                                                                                                                                                                         | 修復類任務被路由到 small 模型，導致模型停止回應                                                                                                  | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 12: 停滯偵測門檻修正**：僅 `tools?.length > 0 && s.length < 30` 才視為停滯，純聊天短回應不觸發                                                                                                                                                                                                                                                                                                                                                                      | 無工具時短回應不應視為停滯，過度積極引發誤判                                                                                                     | ✅ 可安全撤回                               |
| 2026-07-04 | **Fix 13-17: 空內容備用循環 3 次上限 + 專用失效門檻 + 模型健康持久化**：`MAX_EMPTY_RETRY=3`、`EMPTY_CONTENT_FAIL_THRESHOLD=2`、`saveModelHealth()`/`loadModelHealth()` 5 分鐘自動儲存                                                                                                                                                                                                                                                                                     | 12 個備用模型逐一嘗試浪費 12 秒，連續空內容應快速失效                                                                                            | ✅ 可安全撤回                               |
| 2026-07-06 | **Fix 18: Chrome Fetch 斷路器永久禁用**：冷卻達 maxCooldown 且連續失敗 ≥6 次 → `_permanentDisabled=true`                                                                                                                                                                                                                                                                                                                                                                  | 達到 maxCooldown 後仍無限重試浪費資源                                                                                                            | ✅ 可安全撤回                               |
| 2026-07-06 | **Fix 19: write 工具自動建立目錄**：`mkdirSync(dir, {recursive: true})` + `Bun.write` 降級 `fs.writeFileSync`                                                                                                                                                                                                                                                                                                                                                             | 模型在不存在的目錄建立檔案靜默失敗                                                                                                               | ✅ 可安全撤回                               |
| 2026-07-06 | **Fix 20: `os` import 修正**：補上 `import os from "node:os"`                                                                                                                                                                                                                                                                                                                                                                                                             | 缺少 os import 導致 model-health 持久化拋錯                                                                                                      | ✅ 可安全撤回                               |
| 2026-07-06 | **Fix 21: bash 超時 30s→60s + cwd 支援**：execShellAsync timeout:60000 + args.cwd 傳遞                                                                                                                                                                                                                                                                                                                                                                                    | 大型型別檢查/build 任務 30s 不足中斷                                                                                                             | ✅ 可安全撤回                               |
| 2026-07-06 | **Fix 22: 非 bash 程式碼區塊自動轉 write tool_calls**：40+ 語言副檔名映射 + 路徑推斷（註解/前方文字）                                                                                                                                                                                                                                                                                                                                                                     | 模型輸出 `tsx/`py 等區塊時檔案建立永遠不執行                                                                                                     | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v6): 空內容重試停滯根治**：重試迴圈對「空內容「或」逾時/錯誤」都計數，首敗即跳（原只計空內容、閾值 2 → 5 候選全跑完 25s 卡死）                                                                                                                                                                                                                                                                                                                          | WAF 全域阻擋時候選回逾時而非空內容，原邏輯不計導致對話框長時間停滯                                                                               | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v6): 錯誤可複製**：`buildErrorResponse` content 從 `""` 改為 `⚠️ {msg}`，錯誤文字進對話框可複製（保留 terminal log）                                                                                                                                                                                                                                                                                                                                    | 使用者抱怨錯誤只在終端機無法複製                                                                                                                 | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v6): Chrome timeout 加速**：WAF 模式閾值 2→1 次，正常 15s→10s / WAF 8s；備用路徑 25s→15s / 12s→8s                                                                                                                                                                                                                                                                                                                                                       | 首次 WAF 阻擋就浪費 15s+8s，加速失敗感知                                                                                                         | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v7): 串流直通 idle 逾時根治停滯**：新增 `readChunkWithIdleTimeout` + `SSE_IDLE_TIMEOUT_MS=45000`，passthrough 迴圈上游卡死即送 `[DONE]` 不阻塞                                                                                                                                                                                                                                                                                                          | 上游 Chrome SSE 被 WAF 阻擋時 `reader.read()` 永久阻塞，對話框永遠「工作中」、tool_calls 不送達                                                  | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v7): 錯誤訊息不滯留對話框**：`buildErrorResponse` 回退 v6，content 設空字串 `""`（保留 key），錯誤僅 terminal                                                                                                                                                                                                                                                                                                                                           | v6 把錯誤塞進 content 導致滯留對話框，違反「錯誤只進終端機」需求                                                                                 | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v8): 錯誤可複製定案**：`buildErrorResponse` 回退 v6 行為，`content: "⚠️ {msg}"` 進對話框可複製 + terminal log。解決 v6/v7 反覆橫跳技術債，滿足使用者「錯誤要能複製」需求                                                                                                                                                                                                                                                                                | v7 設空字串導致對話框空白、無法複製、以為卡死                                                                                                    | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v8): 重試降級卡死修復**：`requestUpstream` router 失敗後降級 `postJSON` 的 `retries` 改 0（原 2 → 3×60s=180s 卡死），對話框不再長期「工作中」                                                                                                                                                                                                                                                                                                           | WAF 阻擋時重試迴圈卡 180s，使用者以為停滯                                                                                                        | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v8): Chrome 預熱失敗加速**：`createChat 失敗` catch 補 `_cbRecordFail(true)`，預熱失敗即觸發 WAF 模式縮短 Chrome timeout                                                                                                                                                                                                                                                                                                                                | 預熱失敗未標記 WAF 模式，Chrome timeout 維持 10s 未加速                                                                                          | ✅ 可安全撤回                               |
| 2026-07-08 | **Fix 2026-07-08 (v8): 動態 idle 逾時**：`SSE_IDLE_TIMEOUT_MS` 改 `_getSseIdleTimeout()`，WAF 風暴時 45s→8s，避免串流直通路徑對話框停滯                                                                                                                                                                                                                                                                                                                                   | WAF 阻擋時上游 SSE 卡死 45s 才放棄，對話框長期停滯                                                                                               | ✅ 可安全撤回                               |
| 2026-07-13 | **Fix 29: 跨家族空內容重試根治**：新增 `_modelFamily()` 識別家族；空內容重試消費 `config/models.js` 的 `emptyAction` 策略；核心注入跨家族候選（max/coder/small/plus/qwq）根治同家族集體失敗；截斷候選時保留跨家族優先權；早退邏輯改為家族感知（同家族連續 2 次才放棄）；路由依 `emptyAction=enable_thinking` 強制 thinking；`analyzeStall` 的 switchModel 映射修正為跨家族；認知提示注入擴展至純聊天模式；路由日誌加入 `getCognitionSummary` 摘要                         | WAF 全域阻擋時同家族（plus→plus-thinking）集體失敗，連續 2 次即判定全域放棄，從未嘗試 max/27b/coder 等不同家族 → 對話忽然停止、建立文件停滯      | ✅ 可安全撤回                               |
| 2026-07-13 | **Fix 30: 停滯誤判降級（完成態詞）**：`_isStalling` 長文意圖偵測新增 `doneWords`（已完成/已建立/剛才/already…），含完成態描述不判停滯。避免模型已執行卻被強制矯正打斷                                                                                                                                                                                                                                                                                                     | 長文含「建立/執行」意圖詞即判停滯，但模型可能已描述「剛才已建立」→ 誤觸矯正、對話框跳動                                                          | ✅ 可安全撤回                               |
| 2026-07-13 | **Fix 31: 矯正失效根治（多輪強制重試）**：停滯矯正由單次改為最多 2 輪 `for` 迴圈；矯正訊息第 1 輪要求 write 工具呼叫/程式碼區塊，第 2 輪強制 write function call；所有輪失敗才回原始文字。修復 `_totalSize` 未定義 ReferenceError（重試上下文裁減日誌崩潰）                                                                                                                                                                                                               | 單次矯正後仍無 tool_calls → 直接回原始文字（使用者見「沒改善」）；WAF 風暴下模型首輪常空內容，需二次機會                                         | ✅ 可安全撤回                               |
| 2026-07-13 | **Fix 32: 跨裝置定義完善（目標系統偵測）**：`config/paths.js` 新增 `getTargetOS()`（依 `TARGET_OS` 環境變數或 `process.platform`）+ `logCrossDeviceWarn()`；`config/models.js` `getDeviceInfo()` 回傳 `targetOS` 欄位；`platform.js` 轉介 `logCrossDeviceWarn`；chat-proxy 啟動輸出跨裝置警告。路徑依「使用者目標系統」切換，非僅 hostOS                                                                                                                                  | 原跨裝置僅偵測 laptop/desktop 硬體與 process.platform，未偵測「使用者當前所用系統」來切換程式碼路徑，與需求語意不符                              | ⚠️ 需保留 config/paths.js、config/models.js |
| 2026-07-13 | **Fix 33: 工具名通用化（根治 qwen_bash 無效）**：`_toolFull()` 改為回傳裸名（不補 `qwen_` 前綴），bash-block 轉換路徑（主要路徑）產生的 tool_calls 名稱改為通用裸名 `bash`/`write`/`read`...。opencode 實際工具為裸名，原補前綴導致 `invalid [tool=qwen_bash]` → 建檔/執行停滯                                                                                                                                                                                            | 原生 tool*calls 路徑（L3179）已去前綴，但 bash-block 轉換路徑（11 處 `_toolFull`）仍補 `qwen*` 前綴 → opencode 不認識 → 工具呼叫失敗、檔案不建立 | ⚠️ 需保留通用裸名設計                       |
| 2026-07-13 | **Fix 34: 工具名完全去廠商綁定**：`index.js` TOOLS 註冊名由 `qwen_*` 改為裸名（`bash`/`read`/`write`/`edit`/`glob`/`grep`/`skill_list`...），與 opencode 實際工具名一致；`_QWEN_TOOLS` 改名 `_SYS_TOOLS`，`_toolBase` 去前綴正則由 `/^qwen_/` 改為 `/^[a-z]+_/`（支援任意廠商前綴 qwen*/claude*/gem\_）。代理廠商直接在 opencode 環境執行本系統工具，不特異定義廠商工具                                                                                                   | 原工具名綁死 Qwen 前綴，違反「代理廠商應習慣在 opencode 環境執行本系統工具」原則；未來新增其他廠商代理需特別定義前綴                             | ⚠️ 需保留通用裸名設計                       |
| 2026-07-13 | **小模型學習大模型（知識庫/維基/記憶/lesson 調用）**：chat-proxy 新增 `_SYS_LEARN_RE` 辨識系統工具（memory*\*/knowledge*\_/wiki\_\_/lesson/self_learn*/self_config*/self_record\*）；`max-preview` 產出含系統工具調用的優質回應時 `storeShadowExample(taskType="system-usage")` 儲存為 shadow 範例；小模型(27b/plus)請求時 `getShadowExamples(_q,2,"system-usage")` 召回注入 system prompt 引導模仿主動調用。兩者並行（離線範例庫 + 運行時 Few-Shot）                     | 小模型不主動調用知識庫/維基/記憶/學習經驗，錯失大模型既有脈絡；透過蒸餾大模型行為補足                                                            | ⚠️ 需保留 shadow 接線                       |
| 2026-07-13 | **系統工具主動調用引導（prompt 教會模型）**：`_TOOL_FMT_GUIDE` 新增【主動調用系統工具】段，教模型遇查經驗/知識/記憶/偏好時先呼叫 lesson / knowledge*query / wiki_search / wiki_read / memory_recall / self_record_feedback / self_learn*\* 等裸名工具再回應。補足「被動 shadow 學習」啟動前無範例可學的空窗                                                                                                                                                               | 原僅教 bash/write 格式，未教系統工具調用 → 模型不主動查 lesson/知識庫/記憶 → 你見「模型未觸發 self-learning 插件」                               | ⚠️ 需保留引導段                             |
| 2026-07-13 | **Fix 35: 空內容不誤觸停滯矯正**：`_isStalling` 空回應（`<5` 字）分支由 `return true`（視為停滯）改為 `return false`。`Completion:0` 多為上游 WAF/網路阻擋（curl-impersonate 回 200 空內容），非模型「只說不做」；空內容重試路徑已嘗試其他候選，仍空表示全域阻擋，矯正輪只會再收空、浪費請求並延長「工作中」體感。空回應直接回傳原始文字，不觸發 2 輪矯正                                                                                                                 | 日誌實測：WAF 空內容時仍觸發「🧟 偵測到停滯」2 輪矯正，每輪仍收空 → 純浪費 ~12s 且體感「工作中忽然停止」                                         | ✅ 可安全撤回                               |
| 2026-10-18 | **Fix 45: 對話前多餘注入瘦身**（4 檔）<br>①`buildToolPrompt` 移除內嵌 promptHint（原與呼叫端 `_cogHint` 雙重注入）<br>②`buildAdaptivePrompt` 環境認知加起手式：動手前先查使用者習慣/過往經驗（memory/wiki，有需要才查）、回覆省前言直接給動作<br>③`self-learning.js` proLevel 4/5 去「開頭→分析→結論」硬結構（對話前鋪陳來源）<br>④記憶尾註刪除、shadow 標題精簡、`_REPAIR_HINT` 80字→單行<br>⑤`config/model-cognition.js` 全模型 promptHint 改寫 opencode 場景事實性文案 | 每輪 system 疊 5 層注入、命令式文本重複 → 過度指示致模型先複述計畫再動作，浪費 token（前例 Fix 2026-10-18 僅修 adaptive 未完善）                 | ✅ 可安全撤回                               |
| 2026-11-05 | **Fix 46: 失敗續作／禁止反問（光說不做事根治）**（2 檔）<br>①`qwen2api/src/utils/tool-prompt.js` buildToolSystemPrompt Rules 新增 4 條：工具失敗立即換工具／路徑繼續、禁止中途詢問確認、禁止捏造 `<tool_response>`、不要以反問結尾<br>②`qwen2api-plugin/src/chat-proxy.js` CAPABILITY_DEF 新增對應 4 句；新增 `stripFabricatedToolResponses()`，`buildTextResponse`／`buildToolCallResponse` 統一移除 content 內捏造的 `<tool_response>...</tool_response>`（含未閉合尾端），全假時換顯示「⚠️ 模型輸出只含捏造的假工具結果，已自動略過」 | 模型遇第一個工具錯誤（如 File not found）即停止反問使用者、不繼續自主查找；且會捏造假 `<tool_response>` 混入 opencode 上下文（實測複現）       | ✅ 可安全撤回                               |
| 2026-11-05 | **Fix 53: 「光說不做事」雙主因**：①串流 tool_calls 原本緩存後補發在 `[DONE]` 之後（client 收工即丟棄），改以 `deferredTail` 扣住上游 finish/usage/[DONE]，收尾固定順序 tool_calls→finish_reason→usage→[DONE]（缺 finish 自動補 `tool_calls`）；②帶工具時開思考會讓模型只吐「思考 Process」計畫（實測 tool_calls 1/4 vs 關思考 4/4），新增 `forceNoThink`（模型名含 thinking 除外）；③`trimToolsToBudget` 新增 `minifyToolDef` 極簡化階段，避免 53 工具被砍到 4 | OpenAI 客戶端收到 `[DONE]` 即結束串流，工具呼叫被丟棄；上游 Qwen 帶工具+thinking 的 agentic 穩定性差；工具被砍光使模型無工具可用 | ✅ 可安全撤回 |

### qwen2api-plugin/src/provider/provider.js（免額處理）

| 日期       | 修改內容                                                                                                                                                                                                                                                                         | 原因                                                                                                                       | 是否可撤回           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2026-07-13 | **免額耗盡標記（403 quota）**：新增 `quotaExhaustedUntil` / `quotaResetAt` 狀態；`available` 納入 quota 檢查；`recordSuccess` 清除 quota 標記（使用後判斷系統趨向）；403 quota 標記等重置、不計斷路器；`_parseQuotaReset` 預設下一個 UTC+8 午夜（DashScope 每日 00:00 北京重置） | 原 403 被 `_isRetryable` 視為不可重試 → recordFailure → 斷路器 5 次永久跳過 → 降級 Chrome 路徑；免額耗盡應等重置而非計失敗 | ⚠️ 需保留 quota 邏輯 |

### qwen2api-plugin/src/provider/router.js（免額標示）

| 日期       | 修改內容                                                                                                                                                                                                                                     | 原因                                                                   | 是否可撤回           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------- |
| 2026-07-13 | **免額耗盡直觀標示（節流）**：`exec()` failover 迴圈與 catch 區加入 `🔶 {name} 免額耗盡，剩 N 分恢復 → 系統即將改用其他路線執行`；`_quotaReported` Map 追蹤：首次一次報告，剩 ≤5 分（接近重置）才再廣播一次，免額過期自動清除狀態            | 免額耗盡時需直觀告知即將切換路線，但避免每輪輪詢刷屏；接近重置才再提示 | ⚠️ 需保留 quota 標示 |
| 2026-07-13 | **斷路器開啟日誌節流（request.js）**：`sendChatRequest` 斷路器開啟分支（冷卻期跳過 DashScope）新增 `_cbOpenLogged` 旗標，每個開啟週期僅輸出一次 `[DashScope] 斷路器開啟中，跳過直達 Chrome/axios`，成功/失敗重置時清除；避免每輪請求重複刷屏 | 原每輪請求都輸出 warn 致斷路器開啟期間日誌刷屏，與免額標示節流原則一致 | ⚠️ 需保留節流設計    |

### qwen2api-plugin/src/platform.js

| 日期       | 修改內容                                                                                                                                                         | 原因                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-07-09 | **Fix 34: `timer is not defined` 根治**：`execShellAsync` 將 `_timer` 宣告提升至 `finish`/`catch` 作用域內並統一引用（原 `finish`/`catch` 參考不存在的 `timer`） | 每次執行 bash 工具都拋未捕捉 exception，被 keepalive 吞掉，對話看似卡住 |

### qwen2api-plugin/src/start-proxy.js

| 日期       | 修改內容                                    | 原因               |
| ---------- | ------------------------------------------- | ------------------ |
| 2026-07-02 | 啟動重試：失敗 3 次後保持程序活著不強制離開 | 避免閃退後不再重啟 |

### qwen2api-plugin/src/color.js（新增檔案）

| 日期       | 修改內容                                            | 原因                                    |
| ---------- | --------------------------------------------------- | --------------------------------------- |
| 2026-07-02 | 新增統一色彩系統（TrueColor/16色/無色環境自動降級） | 12 個模組共用一致色彩，錯誤訊息紅色加粗 |

### qwen2api/src/server.js

| 日期       | 修改內容                                      | 原因                          |
| ---------- | --------------------------------------------- | ----------------------------- |
| 2026-06-30 | process.on("exit") 殺 Chrome + 啟動前孤兒掃描 | Chrome 孤兒進程堆積耗盡記憶體 |

### qwen2api/src/utils/request.js（免額標示 — 核心服務層）

| 日期       | 修改內容                                                                                                                                                                                                        | 原因                                                                                                                                                     | 是否可撤回           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2026-07-13 | **免額耗盡直觀標示（核心層）**：403 處理分支偵測 body 含 quota 關鍵字時呼叫 `_logQuotaExhausted()`；`_quotaReported` Map 節流（首次一次報告，剩 ≤5 分接近重置再廣播）；`_parseQuotaReset` 預設下一個 UTC+8 午夜 | 實際 403 發生在 qwen2api 核心服務 request.js（非 chat-proxy provider.js），核心層已內部降級成功，導致 chat-proxy 層 🔶 標示從未觸發 → 使用者見「沒改善」 | ⚠️ 需保留 quota 標示 |

### qwen2api/src/utils/chrome-fetch.js

| 日期       | 修改內容                                                                                                                                                                                                                                                      | 原因                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-06-30 | headless: false（WAF 繞過需要），禁止改為 true                                                                                                                                                                                                                | WAF 封鎖 headless 瀏覽器                                                                 |
| 2026-07-04 | **Fix 6: Chrome 崩潰串流銷毀**：disconnected 事件中遍歷銷毀所有 active streams，參考 `_stream`/`_tid` 清理                                                                                                                                                    | browser disconnected 時未銷毀 streams 導致串流卡死                                       |
| 2026-07-04 | **Fix 7: page.evaluate await 修復**：扁平化 async function，`doFetch()` Promise 追蹤完整生命週期                                                                                                                                                              | page.evaluate 內部錯誤無法傳遞給 `.catch()`，錯誤靜默吞掉                                |
| 2026-07-06 | **Fix 18: 斷路器永久禁用**：冷卻達 maxCooldown 且連續失敗 ≥6 次 → `_permanentDisabled=true`                                                                                                                                                                   | 達 maxCooldown 後仍無限重試浪費資源                                                      |
| 2026-07-08 | **Fix 32 v5: 階梯式斷路器恢復 + WAF 模式感知**：永久禁用改為 8 次觸發、階梯式恢復（2min/3min/1min）、WAF 狀態匯出供 request.js 判斷                                                                                                                           | WAF 短暫波動時固定 5min 鎖死過長、request.js 無 WAF 狀態可參考                           |
| 2026-07-08 | **Fix 32 v5: 隨機 viewport + google 預導航繞過 WAF**：`_freshInitPage` 先導航 google.com 再跳目標、隨機化 viewport                                                                                                                                            | WAF 辨識 headless Chrome 直接攔截                                                        |
| 2026-07-08 | **Fix 33: WAF 模式加速 — `_cbRecordFail(true)`、SSE 降級略過、防雙重計數、abort handler WAF 標記**：init/SSE/abort handler 三處傳遞 isWaf=true 啟動 \_wafMode；signal.aborted 或 WAF 模式跳過 main page retry 省 20s；signal.aborted 時不重複計入 CB.failures | 無真實金鑰時 DashScope 降級不可用，SSE 雙重 retry + 雙重計數導致 Chrome 3 請求即永久禁用 |

| 日期       | 修改內容                                                                                                              | 原因                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 2026-07-04 | **Fix 8: ERROR 永遠輸出 stderr**：ERROR 級別無條件輸出至 stderr（與 SSE stdout 隔離），不受 `allowConsoleOutput` 影響 | `allowConsoleOutput` 預設 false 導致所有 logger.error 看不見 |

### qwen2api/src/controllers/chat.js

| 日期       | 修改內容                                                                                                                     | 原因                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2026-07-04 | **Fix 9: pipeUpstream 閒置超時行銷毀**：提取 `cleanup()` 統一 destroy stream + removeAllListeners，idle timeout 不再懸而未決 | 閒置超時 resolve 但未 destroy 上游串流，Promise 懸而未決 |
| 2026-07-04 | **Fix 10-11: headersSent 保護**：串流/非串流 catch 加入 `res.headersSent` 檢查，防止串流開始後誤送 res.status(500)           | 串流開始後再送 status code 導致 Express 內部錯誤         |
| 2026-07-04 | **Fix 14: 上游空內容日誌**：串流/非串流路徑皆加入 `⬆️ 上游回傳空內容` 警告日誌                                               | 空內容時無日誌可追蹤，除錯困難                           |
| 2026-11-05 | **Fix 47: `write after end` 根治**：①`safeWrite`/`safeEnd` 改查 `writableEnded`；②keepalive 改用 `safeWrite`（原 raw `res.write` 的 write-after-end 為非同步 `_write` error 事件，try/catch 攔不住）；③`pipeUpstream`（串流/非串流兩處）為 `res` 掛 `on('error')`，不再成為未捕獲異常；④WAF／一般錯誤在 headers 已送出時，補寫 OpenAI 標準 SSE error 幀 + `[DONE]` 再 `safeEnd`（原靜默 return/不收尾，client 掛死且殘缺串流當正常 stop 存檔） | 上游被 WAF 阻擋後日誌出現 `未捕獲異常: write after end`；且串流中途 WAF 時 client 永久等待、對話歷史被污染 |
| 2026-11-05 | **Fix 48: 全 catch 路徑 headersSent 兩側都收尾**：頂層錯誤（"Invalid token"）在 headersSent 時改寫 SSE error 幀 + `[DONE]`；`safeWrite` 失敗靜默跳過，協定完整 | 同 Fix 47，補齊最後未收尾的出口 |

### qwen2api/src/browser-proxy.js（新增區塊 2026-11-05）

| 日期       | 修改內容                                                                                                | 原因                                             |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2026-11-05 | **Fix 49: `_safeResWrite`**：新增 helper（`!destroyed && !writableEnded` 才寫），取代 5 處 raw `res.write`（RPA onChunk、RPA 最終結果、poll 迴圈 flush）；poll 寫入失敗時中止輪詢並結束回應 | 暫時頁面串流 client 斷線後仍寫 → write after end |

### qwen2api/src/controllers/chat.image.video.js（新增區塊 2026-11-05）

| 日期       | 修改內容                                                                                                                                                  | 原因 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 2026-11-05 | **Fix 52: 串流收尾 3 處 raw `res.write` 加 `destroyed`/`writableEnded` 檢查；兩處 `keep-alive` setInterval 補 `destroyed` 檢查** | 同上，圖像/影片生成端點防 write after end |

### qwen2api/src/controllers/anthropic.js（新增區塊 2026-11-05）

| 日期       | 修改內容                                                                                 | 原因 |
| ---------- | ---------------------------------------------------------------------------------------- | ---- |
| 2026-11-05 | **Fix 50: `writeAnthropicEvent` 加 `destroyed`/`writableEnded` 守衛**，client 已斷線則不寫 | 同上，Anthropic SSE 路徑防 write after end |

### qwen2api/src/controllers/cli.chat.js（新增區塊 2026-11-05）

| 日期       | 修改內容                                                                 | 原因 |
| ---------- | ------------------------------------------------------------------------ | ---- |
| 2026-11-05 | **Fix 51: CLI 透傳寫入前檢查 `destroyed`/`writableEnded`，斷線直接跳過** | 同上，CLI 透傳路徑防 write after end |

### qwen2api-plugin/src/intelligent-tuning.js

| 日期       | 修改內容                                                                                                                       | 原因                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 2026-07-04 | **Fix 4-5: 行為數據持久化**：新增 `_save()/_load()` 至 `~/.opencode/tuning/tuning-data.json`；修正語法錯誤（重複宣告/require） | 進程重啟後行為數據遺失，智能微調失去歷史參考 |

### qwen2api/src/utils/request.js

| 日期       | 修改內容                                                                                                                         | 原因                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 2026-06-30 | 帳戶輪換邏輯、逾時重試機制                                                                                                       | 上游限流時自動切換帳戶                               |
| 2026-07-08 | **Fix 32 v5: 連續 WAF 阻擋追蹤 + DashScope 自動降級**：新增 `_consecWafBlocks` 計數，連續 3 次 WAF 自動切 DashScope（有 key 時） | WAF 阻擋獨立處理無法觸發降級、每次等 Chrome 15s 浪費 |
| 2026-07-08 | **Fix 32 v5: 動態 Chrome timeout**：從斷路器取得 WAF 模式，WAF 阻擋時縮短 Chrome timeout 至 8s（主路徑）/12s（備用路徑）         | WAF 阻擋時仍等 15s/25s，累積浪費時間                 |

### config/models.js（新增：跨裝置模型定義統一管理）

| 日期       | 修改內容                                                                                                                                     | 原因                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-07-04 | 新增 `config/models.js`：裝置角色（laptop/desktop）偵測、等級推薦、跨裝置模型預設值、硬體黑名單統一管理                                      | 避免 chat-proxy.js 硬編碼雙機不一致                                  |
| 2026-07-13 | **Fix 29: `emptyAction` 欄位定義**：為每個模型新增 `emptyAction`（enable_thinking/retry_thinking/switch_model/skip），指揮空內容時的修復動作 | 認知系統需跨裝置共用定義，原僅 chat-proxy 內部邏輯、未與 config 串接 |

### config/model-cognition.js（新增：認知系統 — 跨裝置共用定義）

| 日期       | 修改內容                                                                                                                                    | 原因                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 2026-07-13 | **Fix 29: `analyzeStall` 空內容弱點匹配擴充**：plus 家族 `stall-on-empty` 也觸發跨家族建議（coder→coder 家族、thinking→plus-thinking 家族） | 原僅特定模型匹配，plus 被 WAF 阻擋回空內容時未建議跨家族切換，對話停滯 |

### config/paths.js（唯一路徑真相來源）

| 日期       | 修改內容                                   | 原因                                         |
| ---------- | ------------------------------------------ | -------------------------------------------- |
| 2026-07-01 | 跨裝置路徑集中管理（Linux/Windows 雙平台） | 避免路徑分散各檔案，升級時需同步設備特定路徑 |

### qwen2api/src/utils/tool-prompt.js（新增於 2026-11-05）

| 日期       | 修改內容                                                                                                              | 原因                                            | 是否可撤回 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| 2026-11-05 | `buildToolSystemPrompt` Rules 新增反空想描述事實句：行動請求須直接輸出 `<tool_call>`、禁止只描述計畫                    | qwen3.6-plus 泛化 prompt 下 1/9 只說不做        | ✅ 可撤回  |

### telegram-memory-bridge/src/ （以下為偏離原始 dev1 版本）

| 檔案     | 修改內容                                                                                | 原因                                  |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| bot.ts   | askAI 超時保護鏈（65s timeout → store.ts qwenAsk 60s semaphore）                        | 避免 Telegram bot 請求懸掛不回應      |
| bot.ts   | 記憶儲存邏輯改善：cls===null + text≥80 仍儲存 fact；store=false + text≥300 低重要性儲存 | 分類失敗或 store=false 時內容完全丟棄 |
| store.ts | semaphore 超時降級為 trivial 回應而非拋錯                                               | 系統過載時不讓請求鏈斷裂              |
| store.ts | qwenAsk 動態超時（small 15s / medium 30s / large 45-60s）                               | Governor 根據系統負載調整             |

## 變更紀錄（時間序）

| 日期       | 變更內容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 檔案                                                                                                                                                                  | 相關教訓                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| 2026-11-05 | **Fix 47-52: `write after end` 根治（qwen2api:3000）**：`safeWrite`/`safeEnd` 查 `writableEnded`；keepalive 改 `safeWrite`；兩處 pipeUpstream 為 res 掛 `on('error')`；headersSent 後的 WAF／一般錯誤改寫 SSE error + `[DONE]` 收尾；browser-proxy/anthropic/cli.chat/chat.image.video 同類 raw write 全補守衛；SIGINT+nohup 重啟（pid 658301），health ok、煙霧測試（qwen3.8-omni-flash，"ok"）、新日誌 0 筆 write after end | `qwen2api/src/controllers/chat.js`、`browser-proxy.js`、`controllers/anthropic.js`、`controllers/cli.chat.js`、`controllers/chat.image.video.js` | lesson `2026-11-05-0630-qwen2api-write-after-end-fix.md` |
| 2026-11-05 | 「光說不做事」修復：矩陣實測 qwen3.7 上游恆 500、qwen3.6-plus 泛化 prompt 空想描述；tool-prompt 加反描述規則；free-tier 預設改 qwen3.6-plus、qwen3.7 四項 tool_call:false；qwen2api 改 SIGINT+nohup（pid 322077）；01:02 起上游 WAF 封禁（405 HTML 頁），效果待封禁解除複測 | `qwen2api/src/utils/tool-prompt.js`、`opencode.free-tier.json` | lesson `2026-11-05-0111-qwen-toolcall-auto-waf-ban.md` |
| 2026-11-05 | 健康報告模型探針靜默吞掉 HTTP 5xx：`genReport()` `r.ok===false` 無 else → `🧠模型:` 行消失且誤顯示 100%；補 `🧠模型:❌(upstream 狀態碼)` + 重試一次 | `start.mjs` | lesson `2026-11-05-0120-genreport-silent-upstream-failure.md` |
| 2026-11-05 | **「光說不做事」雙主因修復（chat-proxy:3456）**：①串流 `tool_calls` 原本被補發在 `[DONE]` 之後，client 已收工 → 改 `deferredTail` 扣住 finish/usage/DONE，收尾順序 tool_calls→finish→usage→DONE；②帶工具開思考致模型只吐計畫（1/4 vs 4/4），改為有工具即 `forceNoThink`；③工具超限新增極簡化，53→53 不再砍到 4。實測 5/5 tool_calls、多輪續呼正常 | `qwen2api-plugin/src/chat-proxy.js` | lesson `2026-11-05-1910-qwen-toolcall-stream-order-and-thinking-conflict.md` |
| 2026-06-29 | 修復 nvm 切換後 spawn("node") ENOENT → qwen2api 無法啟動                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | start.mjs                                                                                                                                                             | lesson                                                                               |
| 2026-06-29 | Qwen「只說不做」停滯修復：強化 tool prompt + 停滯偵測矯正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-06-30 | 參考 dev1 補齊文件：.gitignore / config.json / VERSION_SOP 等                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 多個文件                                                                                                                                                              | —                                                                                    |
| 2026-06-30 | Chrome 孤兒進程修復：exit handler + 啟動前掃描                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | server.js / start.mjs                                                                                                                                                 | lesson                                                                               |
| 2026-06-30 | Session stderr 滯留訊息清理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | processor.ts / prompt.ts                                                                                                                                              | lesson                                                                               |
| 2026-06-30 | 建立 AGENTS.md 專案規範                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | AGENTS.md                                                                                                                                                             | —                                                                                    |
| 2026-06-30 | 補齊架構文件：config.json / 啟動流程 / 工具清單等                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ARCHITECTURE.md                                                                                                                                                       | —                                                                                    |
| 2026-07-01 | start.mjs 滯留訊息根治：正常關閉不寫 shutdown.jsonl                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | start.mjs                                                                                                                                                             | lesson                                                                               |
| 2026-07-01 | 建立操作維護 SOP（wiki/02-專案管理）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | wiki                                                                                                                                                                  | sop                                                                                  |
| 2026-07-01 | 一鍵啟動完善：start.sh → start.mjs 委派                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | start.sh / package.json                                                                                                                                               | —                                                                                    |
| 2026-07-02 | 修復 27 處 start.cjs 引用 → start.mjs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 多個文件                                                                                                                                                              | —                                                                                    |
| 2026-07-02 | 修復滯留訊息：buildErrorResponse + 停滯偵測擴大 + 斷線檢查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-02 | 引入統一色彩系統                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | color.js                                                                                                                                                              | —                                                                                    |
| 2026-07-04 | Fix 1: BASE_TIMEOUT 75s→120s（大型任務不中斷）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-04 | Fix 2: 錯誤訊息僅輸出終端機，不進對話框                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-04 | Fix 3: 修復關鍵詞擴充（fix/repair/debug/diagnose）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-04 | Fix 4-5: 智能微調持久化至 `~/.opencode/tuning/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | intelligent-tuning.js                                                                                                                                                 | —                                                                                    |
| 2026-07-04 | Fix 6-7: Chrome 崩潰串流銷毀 + page.evaluate await                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | chrome-fetch.js                                                                                                                                                       | —                                                                                    |
| 2026-07-04 | Fix 8: ERROR 日誌永遠輸出 stderr                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | logger.js                                                                                                                                                             | —                                                                                    |
| 2026-07-04 | Fix 9-11: pipeUpstream 行銷毀 + headersSent 保護                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | chat.js                                                                                                                                                               | —                                                                                    |
| 2026-07-04 | Fix 12: 停滯偵測門檻修正（純聊天短回應不誤判）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-04 | Fix 13-17: 空內容備用 3 次上限 + 失效門檻 + 模型健康持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | chat-proxy.js                                                                                                                                                         | —                                                                                    |
| 2026-07-06 | Fix 18: Chrome Fetch 斷路器永久禁用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | chrome-fetch.js                                                                                                                                                       | lesson                                                                               |
| 2026-07-06 | Fix 19: write 工具自動建立目錄                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-07-06 | Fix 20: os import 修正 + bash 超時 60s + cwd 支援                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | chat-proxy.js/platform.js                                                                                                                                             | lesson                                                                               |
| 2026-07-06 | Fix 22: 非 bash 程式碼區塊自動轉 write tool_calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-07-06 | Telegram Bot 記憶儲存邏輯改善（分類失敗不遺失內容）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | bot.ts                                                                                                                                                                | lesson                                                                               |
| 2026-07-08 | Fix 23: 中斷 tuning 負向迴圈 — urgent 無改善自動恢復 normal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | intelligent-tuning.js                                                                                                                                                 | lesson                                                                               |
| 2026-07-08 | Fix 24: 模型名稱大小寫正規化（toLowerCase）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | intelligent-tuning.js                                                                                                                                                 | lesson                                                                               |
| 2026-07-08 | Fix 25: tuning 感知路由 — 高停滯率模型繞過                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-07-08 | Fix 26: 提高對話壓縮閾值 30K→80K chars / 保留 2→4 則                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-07-08 | **Fix 27: 埠統一 3456** — start.mjs 誤注入 PROXY_PORT=3457，與 config.json/.env/外部配置衝突，opencode 連 3456 全卡死                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | start.mjs                                                                                                                                                             | lesson                                                                               |
| 2026-07-08 | **Fix 28: proxy 自行退出修復** — 前景模式無 keepalive 導致自行退出 (code 0)；launch() 加 chat-proxy 自動重啟 + cleanup 設 \_\_shuttingDown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | start.mjs/start-proxy.js                                                                                                                                              | lesson                                                                               |
| 2026-07-08 | **Fix 29: 裸文字檔案寫入補救** — 新增 looseBlockToToolCalls，處理無 ```fence 的 cat>/echo>/裸程式碼 → tool_calls，解決建立檔案停滯                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | chat-proxy.js                                                                                                                                                         | lesson                                                                               |
| 2026-07-08 | **Fix 30: 插件路徑 keepalive** — startProxy() 內 listen 加 ref keepalive timer；start-proxy.js keepalive 改 ref；startMonitor 發現 proxy down 主動 autoStartProxy 重啟                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | chat-proxy.js/start-proxy.js/index.js                                                                                                                                 | lesson                                                                               |
| 2026-07-08 | **Fix 31: 上游 WAF 雙重校驗根因 + 防停滯** — 上游 Aliyun baxia WAF 升級為 TLS 指紋+動態 cookie 雙重校驗，axios 被回 200+WAF HTML、headless Chrome fetch 遇黑洞無限期掛起→全域空內容。axios 主路徑改帶 Chrome 完整 cookie jar；Chrome 降為備用並加 25s 硬性逾時防對話無限停滯                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | qwen2api/src/utils/request.js                                                                                                                                         | lesson                                                                               |
| 2026-07-08 | **Fix 32 v5: 空內容重試 timeout 動態 + 風暴抑制**：`_lastGlobalEmptyAt` 新增 count 追蹤風暴等級，timeout 動態縮短（5s→2.5s→1.5s）；修復 ts 計時順序 bug（先計算再更新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | WAF 風暴時每個候選等 5s 累積慢、ts 計時順序 bug 導致 count 永遠遞增                                                                                                   | chat-proxy.js                                                                        | lesson |
| 2026-07-08 | **Fix 33: WAF 加速 — \_cbRecordFail(true) + SSE 降級略過 + 防雙重計數**：init/SSE 失敗傳 isWaf=true 啟動 \_wafMode；signal.aborted 或 WAF 模式跳過 main page retry 省 20s；signal.aborted 時不重複計 CB.failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 開發環境無真實金鑰，DashScope 不可用，SSE 雙重 retry + 雙重計數 3 請求即永久禁用                                                                                      | chrome-fetch.js                                                                      | lesson |
| 2026-07-09 | **Fix 34: `timer is not defined` 根治**：`execShellAsync` 將 `_timer` 宣告提升至 `finish`/`catch` 作用域內並統一引用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 每次執行 bash 工具都拋未捕捉 exception 被 keepalive 吞掉，對話看似卡住                                                                                                | platform.js                                                                          | lesson |
| 2026-07-09 | **Fix 35: DashScope 額度耗盡導致對話停止根治**：`_dsUnavailableModels` 由永久 Set 改為帶 TTL(5min) 的 Map，額度恢復後自動重試；`tryModels` 掃描順序將 `qwen-max` 提至第一優先（target 非 max 時）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `qwen-plus`/`qwen-flash` 免費額度耗盡(insufficient_quota) 被永久封鎖 → DashScope 整條路徑判失敗 → 降級 WAF → WAF 阻擋 → 對話忽然停止/工作中停止                       | request.js                                                                           | lesson |
| 2026-07-09 | **Fix 36: DashScope 斷路器恢復時間 2min→30min（全部模型額度耗盡時 2min 重試必敗）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | DashScope 全部模型 403/400（金鑰額度耗盡），2min 後重試仍失敗 → 浪費 round-trip → 斷路器反覆跳閘 → 對話停滯                                                           | request.js                                                                           | —      |
| 2026-07-09 | **Fix 37: 空內容風暴死亡螺旋 timeout 1.2s→15s（原太短導致重試必敗 → 風暴加劇 → 全域熔斷 30s → 對話框空白）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 空內容風暴時 timeout 最低 1.2s，重試必敗 → \_lastGlobalEmptyAt.count 遞增 → timeout 再縮短 → 死亡螺旋。3 候選 × 1.2s ≈ 3.6s 全敗 → 熔斷 → 同批請求快速跳過 → 空白風暴 | chat-proxy.js                                                                        | —      |
| 2026-07-09 | **Fix 38: Passthrough 雙重錯誤靜默吞掉 → 先送錯誤 SSE chunk 再送 [DONE]**（passthrough 失敗 + buffer fallback 也失敗時僅送 [DONE]，對話框空白無任何提示）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | passthrough + buffer fallback 都失敗時只送 [DONE]，使用者看不到錯誤，以為模型卡死 → 對話框永久空白                                                                    | chat-proxy.js                                                                        | —      |
| 2026-07-09 | **Fix 39: Chrome 斷路器第 3+ 次永久禁用 1min→10min（WAF 風暴時快速恢復→立刻失敗→浪費資源）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1min 太短：WAF 風暴時 Chrome 快速恢復→立刻失敗→再次永久禁用→每 1min 觸發 Chrome init 3-5s → 浪費資源，對話體感卡頓                                                    | chrome-fetch.js                                                                      | —      |
| 2026-07-12 | **Fix 40: Context 壓縮翻倍根治**：候選為空時 fallback 取最大訊息作為 candidates，但與 recent(6則) 重疊 → `msgs=[...sys,...compressed,...recent]` 導致同一訊息重複出現，6→12則、53K→106K。改為 candidates 排除 recent 中的訊息；若全部非系統訊息均在 recent 中，則壓縮 recent 後置空 recent 避免重複                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 對話從 6→12 則、52866→105627ch，壓縮反而膨脹，context 越壓越大                                                                                                        | chat-proxy.js                                                                        | lesson |
| 2026-07-12 | **Fix 41: DashScope 400 修復**：(1) 過濾不相容角色/空訊息避免 400；(2) `enable_thinking` 僅 max/plus 送出（flash 不支援）；(3) 訊息內容空時跳過避免空數組 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | qwen-max 回傳 400，`enable_thinking` 參數在 flash 不支援、空訊息數組觸發 400                                                                                          | request.js                                                                           | lesson |
| 2026-07-12 | **Fix 42: 認知系統停滯切換生效**：`analyzeStall.switchModel` 原僅附加建議文字，改為實際切換 `_stallModelOverride` 到重試請求的 model 欄位                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 認知系統定義完善但停滯時未實際切換模型，`switchModel` 建議形同虛設                                                                                                    | chat-proxy.js                                                                        | lesson |
| 2026-10-21 | **Fix 45: 「上游無回應」根因修復（WAF challenge 冷卻）＋ 4377 孤兒埠循環根治**（6 檔）<br>①`provider.js` 新增 `_isChallenge`/`_retryAfterSec`/`_challengeErr`：503/403 chat challenge（「被挤爆啦」）快速失敗，**不重試、不計熔斷**；一般 5xx 重試尊重 Retry-After<br>②`router.js` failover catch 到 `e.challenge` 即中止（同 IP 必敗，failover 只會 hammer）<br>③`chat-proxy.js` 全域 `_challenge` 冷卻（retryAfter 秒），冷卻期直接回「⏳ Qwen 上游風控中，約 Ns 後恢復」取代「上游無回應」；串流直通 503 跳過緩衝重試<br>④`chat-helpers.js` `thinking_budget` 欄位修正（原誤寫 `.budget` 上游不認識），思考等級可由客户端傳 low/medium/high<br>⑤`bot.ts` `isTrivialChat` 重寫：問句與疑問詞前綴不再被判閒聊吞掉（telegram 智能回應回歸）<br>⑥`start.mjs` PORTS 兩處補 `4377`：孤兒 telegram-bridge 佔埠時啟動清理可精準回收，EADDRINUSE 重啟循環根治 | 症狀：尖峰時段大量「上游無回應/所有 Provider 均失敗」（實為 Qwen WAF 風控非網速）；`bun dev` 時 telegram-bridge 無限 EADDRINUSE 重啟（nohup 孤兒佔 4377，清理清單漏埠） | provider.js / router.js / chat-proxy.js / chat-helpers.js / bot.ts / start.mjs | lesson `2026-10-21-0252-qwen-chat-challenge-root-cause-and-4377-orphan` |
| 2026-10-18 | **Fix 44: 免額優先 + 空回覆根治**（6 檔）<br>①**`version` header `0.2.63`/`0.2.67` → `0.3.12`**（10 處：request/chrome-fetch/models-map）—— Qwen 接受連線但**不產生內容**，回 200 + `content:null` 假成功 ★關鍵<br>②`sendChatRequest` 抽出 `sendFreeRequest()` 為第一跳；百煉改需 `DASHSCOPE_ALLOW_FALLBACK=true` 才啟用（預設關閉）<br>③`.env` 補 `FREE_TIER_ONLY=true`（過濾實測 `Model not exist` 的舊付費模型名）<br>④curl 路徑加 `takeBuffered()` 提前補讀首幀（原 listener 掛太晚 → 誤判「無有效內容」→ 降級 hammer Qwen）<br>⑤axios 路徑用 `PassThrough` tee 重建串流偵測 challenge（Axios stream 被消費後無法 unshift）<br>⑥chat challenge → `503 + Retry-After: 30`，連續 3 次熔斷 60 秒                                                                                                                                             | 空回覆（HTTP 200 但 completion_tokens=0）；百煉每請求先燒付費額度，免額正常時也一樣；付費模型過濾失效                                                                 | request.js / curl-fetch.js / chrome-fetch.js / models-map.js / chat.js / .env        | lesson |
| 2026-10-17 | **Fix 43: refresh_token 被撤銷無法取得 access_token 根治**（5 檔）<br>①`token-manager` 新增 `_parseRefreshResponse()` 解析 `x-error-code`/`x-actual-status-code`（Qwen 回 HTTP 200 但標 401，axios 不 throw，真相被掩蓋）<br>②新增 `persistHook` + `account._bindTokenPersist()` 即時落盤輪替後的 cookies<br>③`data-persistence._saveToFile` 白名單補 `cookies`/`refresh_token`/`refresh_token_expires`/`loginMethod`<br>④`_saveAllToFile` 整筆重建 → **merge 語義**（每日歸檔不再抹除 cookies）<br>⑤`ensureFreshToken` browser 模式**移除降級密碼登入**（Qwen 已拒社群帳號，必 400）<br>⑥rotator 加 revoked 排除 + 30 分鐘冷卻（消除日誌洪水）<br>⑦日誌單位 bug：`getTokenRemainingHours()` 回傳**小時**卻印「分鐘」→ `0分鐘` 誤判<br>⑧`refreshViaCookie` 布林鎖 → **共享 Promise**（布林鎖讓併發回 null，5併發中4個報「無法取得通路令牌」） | `TOKEN_REVOKED` 被誤診為「未回傳 access_token」；cookies 從不落盤 + 每日歸檔抹除 → 重啟必用舊 refresh_token → 撤銷；每請求重試造成日誌洪水                            | token-manager.js / account.js / account-rotator.js / data-persistence.js / inject.js | lesson |

### 已知問題（2026-07-12 更新）

| 問題                        | 狀態      | 說明                                                                                                                                                                                                             |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某些模型高超時率            | ⚠️ 未修復 | qwen3.6-plus-thinking ~50%（evolution-engine 會自動路由降級）                                                                                                                                                    |
| Telegram bot 無 Token 模式  | ✅ 已處理 | 已支援節點模式，不綁 Token 亦可啟動                                                                                                                                                                              |
| `process.stderr.write` 殘留 | ✅ 已修復 | processor.ts/prompt.ts 已清理                                                                                                                                                                                    |
| Chrome 孤兒進程             | ✅ 已修復 | exit handler + 啟動前孤兒掃描                                                                                                                                                                                    |
| `timer is not defined`      | ✅ 已修復 | platform.js `execShellAsync` 引用未宣告變數，每 bash 指令拋錯（2026-07-09）                                                                                                                                      |
| Context 壓縮翻倍            | ✅ 已修復 | 候選與 recent 重疊導致訊息數翻倍（2026-07-12 Fix 40）                                                                                                                                                            |
| DashScope qwen-max 400      | ✅ 已修復 | enable_thinking 在 flash 不支援、空訊息觸發 400（2026-07-12 Fix 41）                                                                                                                                             |
| 認知停滯切換未生效          | ✅ 已修復 | switchModel 僅建議文字未實際切換（2026-07-12 Fix 42）                                                                                                                                                            |
| 上游傳回空白（WAF captcha） | ✅ 已修復 | **根因是 `version` header 版本過時**（`0.2.63`→`0.3.12`），非 IP 封鎖。實測 5/5 成功、2.4-2.7 秒、百煉 0 呼叫。殘留：Qwen 尖峰（UTC 07:00-22:00）仍可能 challenge，此時回 503 + Retry-After（2026-10-18 Fix 44） |
| 舊模型名 Model not exist    | ✅ 已修復 | `qwen-max`/`qwen-turbo`/`Qwen3-Coder`/`Qwen3-VL-235B-A22B` 實測皆不存在，已從 opencode 設定與 model-router 移除（2026-10-18 Fix 44）                                                                             |
| 上游無回應（challenge 連鎖） | ✅ 已修復 | 尖峰時段 Qwen WAF chat challenge（503「被挤爆啦」）→ proxy 重試 hammer → 熔斷連鎖。修復：challenge 偵測 → 不重試不計熔斷、全域冷卻、冷卻期回簡短提示（2026-10-21 Fix 45）。**非網速問題** |
| 4377 孤兒埠 EADDRINUSE 循環 | ✅ 已修復 | nohup 手動啟動的 telegram-bridge 殘留佔 4377，start.mjs PORTS 清單漏 4377 永不清理。修復：PORTS 兩處補 4377（精準 PID 過濾，2026-10-21 Fix 45） |
| 思考內容洩漏進 content      | ⚠️ 未修復 | chat.qwen.ai 免費層把思考以純文字放 `content`（無 `<think>`/reasoning_content 標記），SSE parser 無法區隔 → 對話開頭出現「Process: 1. 分析輸出…」。需 heuristic 剝離（2026-10-21 追蹤） |

## 最後更新

2026-07-03: 新增修改追蹤清單（升級本源對照）、修復三大核心問題（錯誤滯留/檔案建立/對話壓縮）
2026-07-03 (v2): 根治 content:null 滯留：response builders 省略 content 鍵 + streaming error 不送 chunk + 純文字串流跳過空內容
2026-07-04: Fix 5（背景模式暫態錯誤不進對話框）、Fix 6（bashBlockToToolCalls 單一 pass + 自動建立目錄）
2026-07-04 (v2): 17 項穩定性修復（BASE_TIMEOUT/認知關鍵詞/Chrome崩潰/錯誤隔離/串流清理/空內容上限/持久化）
2026-07-06: Fix 18-22（Chrome 斷路器永久禁用/write 自動建目錄/os import/bash 超時60s/非bash區塊自動轉寫檔）+ Telegram Bot 記憶儲存邏輯改善
2026-07-08: Fix 23-26（tuning 負向迴圈打破/模型名正規化/tuning 感知路由/壓縮閾值提高）
2026-07-08: Fix 27-29（埠統一3456/proxy自行退出修復+自動重啟/裸文字檔案寫入補救 — 解決「對話忽然停止、建立檔案停滯」）
2026-07-08 (v5): Fix 32（WAF 斷路器加速/空內容風暴抑制/DashScope 自動降級 — 改善 WAF 全域空內容停滯、降低等待感）
2026-07-08 (Fix 33): \_cbRecordFail(true) + SSE 降級略過 + 防雙重計數（開發環境無金鑰，優化 Chrome 降級路徑）
2026-07-09: 新增「對話中斷根因與對策」節（4 層根因 + 預防順序）；Fix 34 根治 platform.js `timer is not defined`（每次 bash 指令拋錯致對話卡住）
2026-07-09 (Fix 35): DashScope 額度耗盡導致對話忽然停止根治 — `_dsUnavailableModels` 改 TTL Map、qwen-max 掃描優先，任何層級請求自動提升到可用的 qwen-max（繞過 WAF）
2026-07-09 (Fix 36-39): 4 項根因修復 — DashScope 斷路器 2min→30min（全部模型額度耗盡）、空內容風暴 timeout 1.2s→15s（打破死亡螺旋）、Passthrough 雙重錯誤不再靜默吞掉（送錯誤 SSE）、Chrome 第3+次永久禁用 1min→10min（減少 WAF 風暴重試）
2026-07-12 (Fix 40-42): 3 項核心修復 — Context 壓縮翻倍根治（候選排除 recent 避免重複）、DashScope 400 修復（剝離 flash 不支援的 enable_thinking + 過濾不相容角色）、認知系統停滯切換生效（switchModel 實際套用到重試請求）
2026-10-17 (Fix 43): Qwen `TOKEN_REVOKED` 根治 — 5 檔修復（撤銷診斷解析/cookies 即時落盤/持久化 merge 語義/移除密碼降級/revoked 冷卻），另修日誌單位 bug 與併發鎖 bug。詳細行號級追蹤見 `docs/2026-10-17-token-revoked-fix.md`。遗留：阿里雲 WAF 封鎖本機 IP（需換出口 IP）

2026-10-18 (Fix 44): 免額優先根治 — 關鍵是 `version` header 版本過時（0.2.63/0.2.67 → 0.3.12）造成 HTTP 200 假成功空回覆；同時把百煉從第一跳降為需明確允許的最後備援（`DASHSCOPE_ALLOW_FALLBACK=false`），並補 curl/axios 兩層 challenge 偵測與熔斷。實測 5/5 成功（2.4-2.7 秒）、百煉 0 呼叫。詳細行號級追蹤見 `docs/2026-10-18-free-tier-priority-fix.md`

2026-10-21 (Fix 45): 「上游無回應」根因修復 — 尖峰 WAF chat challenge → 重試 hammer → 熔斷連鎖。修復：challenge 快速失敗（不重試不計熔斷）+ 全域冷卻 + 冷卻期簡短提示；另修 `thinking_budget` 欄位、telegram `isTrivialChat` 過寬、`start.mjs` PORTS 漏 4377（EADDRINUSE 孤兒循環）。遗留追蹤：思考內容洩漏進 content（上游無 reasoning 標記）。詳 `skill/lesson/2026-10-21-0252-qwen-chat-challenge-root-cause-and-4377-orphan.md`

2026-11-05 (Fix 47-52): `write after end` 根治 — safeWrite/safeEnd 查 `writableEnded`；keepalive 改 safeWrite；兩處 pipeUpstream 為 res 掛 `on('error')`；headersSent 後 WAF/一般錯誤改寫 SSE error+`[DONE]` 收尾（4 出口）；browser-proxy `_safeResWrite`、anthropic、cli.chat、chat.image.video 同類補守衛。qwen2api SIGINT+nohup（pid 658301），health ok、煙霧測試（qwen3.8-omni-flash「ok」），新日誌 0 筆 write after end。詳 `skill/lesson/2026-11-05-0630-qwen2api-write-after-end-fix.md`
