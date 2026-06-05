# Qwen2API 雙機架構規範

## 角色分工

- **筆電（開發端）**：輕量模式，只跑 qwen2api + chat-proxy，不跑 bot/watcher
- **桌機（主機）**：完整模式，跑全部服務（master + bot + indexer + watcher）

## 環境變數

- `TAILSCALE_WATCH=off`：跳過 tailscale 輪詢，節省筆電資源
- `MASTER_IP=100.71.40.106`：跳過 peer 偵測循環，固定連桌機

## 程式碼不碰區

1. `index.ts:76` — `if (process.env.TAILSCALE_WATCH === "off") return "";`
2. `index.ts:117-138` — `hasMasterIP` 角色判斷
3. `index.ts:276-289` — `TAILSCALE_WATCH !== "off"` 保護
4. `index.ts:309-326` — `forcedMaster` 分支（直接連 master）
5. `store.ts:224-234` — 已移除 setTimeout + semRelease（semaphore 計數保護）
6. `api.ts` — knowledge/wiki/read/pull 端點（跨機同步協議）

## Semaphore 規範

禁止硬超時 + semRelease 競爭 pattern。`semAcquire` 自身有 timeout，不需額外保護。

## 智慧上下文強化（/api/ask）

當透過 Telegram 或其他客戶端呼叫 `/api/ask` 時，系統自動搜尋四種來源彙整給模型：

| 來源     | 位置                        | 搜尋方式                          |
| -------- | --------------------------- | --------------------------------- |
| 記憶     | `.opencode/memory/`         | 向量搜尋（`store.searchByModel`） |
| 知識庫   | `.opencode/knowledge/`      | 全文關鍵詞比對                    |
| 維基     | `.opencode/wiki/`           | 全文關鍵詞比對                    |
| 經驗教訓 | `.opencode/lesson-learned/` | 全文關鍵詞比對                    |

模型收到完整上下文後回答，因此使用者問問題時會自動帶入所有相關背景。
