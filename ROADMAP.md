# 🗺 qwen2api-dev 專案路線圖

> **給人類看的專案演化儀表板。** dev = 主要開發線（核心 API + Telegram + 插件系統）。
> dev2 專屬功能（管理後端、追溯系統 TS 等）不在此路線圖中。

---

## 當前狀態

```
🟡 M4 — 上游長推理／WAF 風控防護（2026-11-01，進行中）
🟢 M3 — 三項逾時/上下文修復完成
🟢 M2 — 統一色彩系統整合完成（2026-07-02）
🟢 M1 — dev 基礎清理完成（2026-06-30）
```

---

## 演化路線

```
M4 [2026-11-01] 上游長推理/WAF 防護 ───────────── 當前位置
  └─ 修正 timeout 層級倒置（REQUEST >= THINKING > IDLE）
  └─ 建立 docs/PLAN_UPSTREAM_TIMEOUT_WAF.md
  └─ 程式碼標注逾時規範（config/index.js、chat-proxy.js）
  └─ 待辦：熔斷期短路、write after end 防護、錯誤格式標準化

M2 [2026-07-02] 統一色彩系統 ────────────────── 完成
  └─ 新增 src/color.js 核心模組
  └─ 12 個模組統一引入，[系統錯誤] 紅色加粗
  └─ TrueColor/16色/無色環境自動降級

M1 [2026-06-30] dev 基礎清理 ────────────────── 完成
  └─ 參考 dev1 補齊缺失檔案與配置
  └─ 移除備份殘檔清理
  └─ 確立版本 SOP + 架構文件建立
```

---

## 里程碑詳細

### 🟡 M4 — 上游長推理／WAF 風控防護（2026-11-01）

> 完整計畫：`docs/PLAN_UPSTREAM_TIMEOUT_WAF.md`

| 項目 | 狀態 | 說明 |
| :--- | :--- | :--- |
| timeout 層級修正 | ✅ | laptop：REQUEST 60s→660s、THINKING 120s→600s、IDLE 180s→300s |
| 規範標注 | ✅ | `config/index.js` laptop profile、`chat-proxy.js` CFG_TIMEOUT/t/idle/REQ |
| 計畫文件 | ✅ | `docs/PLAN_UPSTREAM_TIMEOUT_WAF.md` |
| WAF 熔斷期短路 | ⏳ | 熔斷期間停止重試，直接回 503 + Retry-After |
| `write after end` 防護 | ⏳ | 所有 `res.write()` 前檢查 `writableEnded/destroyed` |
| 錯誤格式標準化 | ⏳ | L2723 改為 OpenAI 標準 error 物件 |

### ✅ M2 — 統一色彩系統整合（2026-07-02）

| 項目                   | 狀態 | 說明                                                                                                         |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| 新增 color.js 核心模組 | ✅   | TrueColor、語義色、標籤色、log helper                                                                        |
| 12 個模組統一引入      | ✅   | chat-proxy、start-proxy、index、router、evolution、learning、auth、provider、auto-judge、hardware-detect-cli |
| `[系統錯誤]` 紅色加粗  | ✅   | `c.bold(c.error("[系統錯誤]"))` 極難被忽略                                                                   |
| 環境自動偵測           | ✅   | FORCE_COLOR/NO_COLOR/TERM/TTY 自動降級                                                                       |
| 文件同步更新           | ✅   | ARCHITECTURE.md、AGENTS.md、TROUBLESHOOT.md                                                                  |

### ✅ M1 — dev 基礎清理與 dev1 參考整合（2026-06-30）

| 項目               | 狀態 | 說明                                      |
| ------------------ | ---- | ----------------------------------------- |
| 參考 dev1 補齊檔案 | ✅   | .gitignore / config.json / VERSION_SOP 等 |
| 移除備份殘檔       | ✅   | qwen2api.bak.\* 清理                      |
| .env 雙機配置      | ✅   | TAILSCALE_WATCH + MASTER_IP               |
| 版本 SOP 建立      | ✅   | VERSION_SOP.md                            |
| 架構文件建立       | ✅   | MILESTONES/ROADMAP/ARCHITECTURE           |

---

## 子專案狀態

| 子專案                   | 埠   | 狀態 | 備註                    |
| ------------------------ | ---- | ---- | ----------------------- |
| `qwen2api`               | 3000 | 🟢   | 核心 API 伺服器         |
| `qwen2api-plugin`        | 3456 | 🟢   | 插件系統（含 color.js） |
| `telegram-memory-bridge` | 4377 | 🟢   | Telegram Bot + 記憶橋接 |
| `knowledge-wiki-plugin`  | —    | 🟢   | 知識庫插件              |

---

> 最後更新：2026-07-02
