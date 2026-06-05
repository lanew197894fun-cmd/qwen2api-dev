# Qwen2API 開發環境技能

## 系統概要

雙機架構：筆電（輕量開發端）+ 桌機（主機）。Qwen 模型透過 chat-proxy 提供服務。

## 模型資訊

| 項目     | 值                                   |
| -------- | ------------------------------------ |
| 模型     | Qwen3.6-Max-Preview                  |
| 代理埠   | chat-proxy:3456 → qwen2api:3000      |
| API 格式 | OpenAI 相容 (`/v1/chat/completions`) |

## 可用的 AI 工具（透過 knowledge-wiki-plugin）

| 工具              | 說明                         | 何時使用                     |
| ----------------- | ---------------------------- | ---------------------------- |
| `lesson/save`     | 記錄經驗教訓（預防重複犯錯） | 修復問題後、學到新東西後     |
| `knowledge/save`  | 儲存知識到知識庫（自動分類） | 技術筆記、架構決策、研究結果 |
| `knowledge/read`  | 閱讀知識條目                 | 查閱先前紀錄的知識           |
| `knowledge/index` | 瀏覽知識庫索引               | 快速瀏覽有哪些知識           |
| `wiki/save`       | 儲存維基條目                 | 長期維護的正式文件           |
| `lesson/list`     | 列出所有經驗教訓             | 回顧翻車記錄                 |

## 不可修改的架構邊界

詳細請見 `ARCHITECTURE.md`，摘要如下：

1. **雙機模式**：筆電 `TAILSCALE_WATCH=off` + `MASTER_IP` 不可移除
2. **Semaphore**：禁止 setTimeout + semRelease pattern
3. **端點**：knowledge/wiki/read/pull 不可刪
4. **資料流向**：筆電寫入 → 通知 → 桌機拉取，不可反轉
5. **目錄**：記憶/知識/維基不可放 `system/`

## 智慧上下文

當你問問題時，模型會自動搜尋四種來源作為背景：

- 📝 **記憶** — 過往對話記錄與重點摘要
- 📚 **知識庫** — 技術筆記、架構決策
- 📖 **維基** — 長期維護的正式文件
- ⚠️ **經驗教訓** — 翻車記錄與修復經驗

所以你不需要手動指定哪個來源，直接問就好。

## 常見操作

### 記錄翻車經驗

```bash
# 可在 OpenCode 或 Telegram 執行
/run lesson_save title="xxx" scenario="xxx" mistake="xxx" solution="xxx"
```

### 儲存知識

```bash
/run knowledge_save title="xxx" content="xxx"
```

### 查詢記憶

透過 Telegram bot 直接問即可，模型會自動搜尋相關記憶。

## 啟動指令

```bash
# 筆電（輕量模式）
TAILSCALE_WATCH=off MASTER_IP=100.71.40.106 bun start.js

# 桌機（完整模式）
bun start.js
```

## 資料儲存位置

| 類型     | 路徑                                 |
| -------- | ------------------------------------ |
| 知識庫   | `projects/.opencode/knowledge/`      |
| 經驗教訓 | `projects/.opencode/lesson-learned/` |
| 維基     | `projects/.opencode/wiki/`           |
| 記憶     | `projects/.opencode/memory/`         |
| 架構規範 | `ARCHITECTURE.md`                    |

---

> 最後更新：2026-06-05
