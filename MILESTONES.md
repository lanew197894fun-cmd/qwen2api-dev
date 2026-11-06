# qwen2api-dev 專案里程碑

> **給所有 AI 助手的快速入門文件。**
> dev = 主要開發線（4 子專案），不含管理後端或追溯系統（那些屬 dev2）。

---

## 當前狀態（2026-11-01）

```
🟡 M4 — 上游長推理／WAF 風控防護（進行中）
🟢 M3 — 三項逾時/上下文修復完成
🟢 M2 — 統一色彩系統整合完成
🟢 M1 — dev 基礎清理完成、dev1 參考整合
```

---

## 里程碑時間線

### M4 — 2026-11-01：上游長推理／WAF 風控防護

- 🟡 定位主因：timeout 層級倒置（REQUEST 60s < THINKING 120s < IDLE 180s）
  → 推理 >60s 被請求計時器 `AbortController.abort()` 中斷，回報「上游無回應」
- 🟡 laptop profile 修正：`requestTimeoutMs` 60s→660s、`thinkingTimeoutMs` 120s→600s
- 🟡 `CHAT_IDLE_THINKING_MS` 預設 180s→300s
- 🟡 逾時規範標注：`config/index.js`、`chat-proxy.js`（CFG_TIMEOUT / t / IDLE / REQ）
- 🟡 新增 `docs/PLAN_UPSTREAM_TIMEOUT_WAF.md`（根因、階段、驗收、邊界）
- ⏳ 待辦：WAF 熔斷期短路、`write after end` 防護、錯誤格式標準化
- 🔒 邊界：僅修改 `qwen2api-dev`，禁止寫入 `projects/system`


### M2 — 2026-07-02：統一色彩系統整合

- 🔵 新增 `qwen2api-plugin/src/color.js` 核心色彩模組（TrueColor/語義色/標籤色/log helper）
- 🔵 12 個模組統一引入 color.js，建立一致的日誌色彩規範
- 🔵 `[系統錯誤]` 紅色加粗（`c.bold(c.error("[系統錯誤]"))`），極難被忽略
- 🔵 標籤著色：proxy=藍、系統=灰、router=青、auth=綠、learning=綠、evolution=紫
- 🔵 等級著色：DEBUG=灰、INFO=青、WARN=黃、ERROR=紅
- 🔵 自動環境偵測：`FORCE_COLOR` / `NO_COLOR` / `TERM` / TTY，無色環境自動降級
- 🔵 更新 ARCHITECTURE.md、AGENTS.md、VERSION_SOP.md 記錄變更

### M1 — 2026-06-30：dev 基礎清理與參考 dev1 完善

- 🔴 參考 `qwen2api-dev1` 補齊缺失檔案與配置
- 🔴 移除備份殘檔（`qwen2api.bak.*`）
- 🔴 確立版本 SOP + 架構文件建立
- 🔴 `.env` 雙機架構配置（TAILSCALE_WATCH + MASTER_IP）
- 4 個子專案確認狀態（核心 API / 插件 / Telegram / 知識庫）

---

## 子專案清單

| 子專案                   | 類型 | 說明                                    |
| ------------------------ | ---- | --------------------------------------- |
| `qwen2api`               | 核心 | Express API 伺服器，port 3000           |
| `qwen2api-plugin`        | 插件 | chat-proxy + 工具 + 自我學習，port 3456 |
| `telegram-memory-bridge` | 橋接 | Telegram Bot + 跨機記憶，port 4377      |
| `knowledge-wiki-plugin`  | 插件 | 知識庫/維基系統                         |

---

## 不屬 dev 的功能（請往 dev2）

| 功能           | 所屬 | 說明                                  |
| -------------- | ---- | ------------------------------------- |
| 管理後端       | dev2 | management-backend + .management-dist |
| 帳號管理系統   | dev2 | account-manager, account-monitor      |
| 追溯系統 TS    | dev2 | §24-25 鐵律 + changelog               |
| WAF 管理後台   | dev2 | waf-proxy.js 管理介面                 |
| config-manager | dev2 | 統一配置中心                          |

### M3 — 2026-07-23：三項逾時/上下文修復

- 🔧 **createChat 逾時**（`chrome-fetch.js` L752）：`_freshInitPage()` 耗時 20-25s，外層 Promise.race 只給 30s → 提高至 50s，留足 buffer
- 🔧 **停滯矯正動態逾時**（`chat-proxy.js` L4366）：固定 `timeout: 60000` → `tune.getTimeoutMs(model, 60000)`，慢速模型放寬、快速模型縮短
- 🔧 **重試上下文更積極裁減**（`chat-proxy.js` L3365-3418）：system 3K→2K、4則→3則、每則 2K→1K+tail300、總量 30K→20K，提高重試成功率

**驗證**：兩檔案語法檢查通過，不影響既有架構

---

> 最後更新：2026-07-23
