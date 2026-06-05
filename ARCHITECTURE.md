# Qwen2API-dev 系統架構規範

> ⚠️ **給所有 AI 助手（Qwen、OpenCode、Claude 等）的強制約束**
> 以下規範定義了系統的不可變架構邊界。任何違反這些規範的修改都將破壞系統運行。

---

## 1. 雙機架構（絕對死律）

### 角色定義

| 機器               | 角色        | 資源     | 運行服務                               |
| ------------------ | ----------- | -------- | -------------------------------------- |
| **筆電**（開發端） | 🟡 輕量節點 | 性能較差 | qwen2api + chat-proxy（不跑 bot/監視） |
| **桌機**（主機）   | 🟢 Master   | 資源充足 | qwen2api + chat-proxy + bot + watcher  |

### 環境變數約束

**筆電啟動必須使用以下變數：**

```bash
TAILSCALE_WATCH=off   # 跳過 tailscale status 輪詢（節省 fork 開銷）
MASTER_IP=100.71.40.106  # 跳過 peer 偵測循環，固定連線桌機
```

**🔴 禁止行為：**

- ❌ 移除或忽略 `TAILSCALE_WATCH=off` 的跳過邏輯
- ❌ 移除或忽略 `MASTER_IP` 的強制定向邏輯
- ❌ 在筆電上啟動 Telegram bot（屬於桌機）
- ❌ 在筆電上啟動 tailscale watcher / peer 偵測循環
- ❌ 把 `startPeer()` 中的 `forcedMaster` 分支刪掉

### 程式碼保護（index.ts）

```typescript
// 以下三處修改為刻意設計，禁止還原：

// 🔒 getLocalTailscaleIP() — 第 76 行
if (process.env.TAILSCALE_WATCH === "off") return "";

// 🔒 detectRole() — 第 128 行
role: hasMasterIP && cfg.token && peers.length && !localIP ? "peer" : ...

// 🔒 startPeer() — 第 311 行
const forcedMaster = process.env.MASTER_IP || "";
if (forcedMaster) { /* 直接連，不跑偵測 */ return; }
```

---

## 2. Semaphore 訊號量規範（絕對死律）

### 禁止模式

`telegram-memory-bridge/src/store.ts` 中的 `qwenAsk()` 方法。

**🔴 禁止以下 pattern（已修復的 bug）：**

```typescript
// ❌ 禁止 — semRelease() 在 setTimeout 中可能與 semAcquire 競爭
const hardTimeout = setTimeout(() => {
  if (semActive > 0) semRelease(); // 釋放還沒 acquire 的 slot！
}, HARD_TIMEOUT_MS);
await semAcquire(HARD_TIMEOUT_MS);
clearTimeout(hardTimeout);
```

**✅ 正確做法：**

```typescript
await semAcquire(HARD_TIMEOUT_MS); // 自身有 timeout，不需額外保護
// ... API 呼叫 ...
// finally { semRelease(); }
```

### 原因

硬超時 + semAcquire 各自有 timeout 機制，同時存在會造成計數偏移：
多次超時後 `semActive` 偏離真實值 → 所有新請求永遠拿不到 slot → **完全 hang 住**

---

## 3. API 端點（不可刪除）

`telegram-memory-bridge/src/api.ts` 中新增的端點，用於跨機器資料同步：

| 端點                        | 用途                         | 呼叫方                          |
| --------------------------- | ---------------------------- | ------------------------------- |
| `GET /api/knowledge`        | 列出筆電知識庫檔案           | 桌機 pullFromPeer               |
| `GET /api/wiki`             | 列出筆電維基檔案             | 桌機 pullFromPeer               |
| `GET /api/lesson`           | 列出筆電教訓檔案             | 桌機 pullFromPeer               |
| `GET /api/read?type=&path=` | 讀取筆電知識/維基/教訓內容   | 桌機 pullFromPeer               |
| `POST /api/pull/now`        | 觸發桌機從筆電拉取資料       | 筆電（寫入後通知）              |
| `POST /api/cleanup`         | 通知筆電刪除已驗證同步的檔案 | 桌機 pullFromPeer（驗證後呼叫） |

**🔴 禁止：**

- ❌ 刪除上述任何端點
- ❌ 改變端點路徑或回應格式（會破壞 pullFromPeer 相容性）

---

## 4. 知識工具初始化

`telegram-memory-bridge/src/knowledge-tools.ts`

- 筆電（peer/輕量模式）也需能使用知識工具
- `getProvider()` 應使用 lazy init（延遲初始化），非 master-only 初始化
- **🔴 禁止：** 讓 `/run lesson_save` 等指令在 peer 模式拋錯

---

## 5. 資料同步流向

### 完整流程

```
步驟 1: 寫入
   筆電（本地寫入知識/維基/教訓 .md 檔案）
     │
步驟 2: 通知 (fire-and-forget)
   筆電 → curl POST http://桌機:埠/api/pull/now
     │
步驟 3: 拉取 (pullFromPeer)
   桌機 → GET /api/knowledge → 逐一 GET /api/read → 寫入本地
   桌機 → GET /api/wiki      → 逐一 GET /api/read → 寫入本地
   桌機 → GET /api/lesson     → 逐一 GET /api/read → 寫入本地
     │
步驟 4: 驗證 (hash 比對)
   桌機對每個寫入的檔案計算 md5 hash
   與來源端 /api/read 的 X-Content-Hash header 比對
     │
步驟 5: 清理 (cleanup)
   桌機 → POST /api/cleanup { files: [{ type, path }] }
   筆電收到後刪除已驗證的來源檔案
     │
步驟 6: 回應
   桌機 bot 使用更新後的資料回應查詢
```

### 安全機制

- 每個拉取的檔案都經過 md5 hash 驗證
- 驗證通過前，來源檔案不會被刪除
- 驗證失敗時記錄錯誤，保留來源檔案供重試
- 支援知識庫（knowledge）、維基（wiki）、教訓（lesson）三種檔案類型

**🔴 禁止：**

- ❌ 桌機主動輪詢掃描筆電（浪費資源）
- ❌ 筆電主動推送到桌機（增加筆電負擔）
- ❌ 在 hash 驗證通過前刪除來源檔案
- ❌ 跳過 cleanup 通知直接刪除（會造成桌機未完整接收）
- ✅ 只允許：筆電寫入後 fire-and-forget 通知 → 桌機拉取 → 驗證 → 清理

---

## 6. 依賴目錄

| 項目     | 位置                                                  | 說明                                              |
| -------- | ----------------------------------------------------- | ------------------------------------------------- |
| 記憶     | `projects/.opencode/memory/`                          | 相對路徑自 `telegram-memory-bridge/src/` 向上四層 |
| 知識庫   | `projects/.opencode/knowledge/`                       | 同上                                              |
| 維基     | `projects/.opencode/wiki/`                            | 同上                                              |
| 教訓     | `projects/.opencode/lesson-learned/`                  | 同上                                              |
| 知識插件 | `knowledge-wiki-plugin/src/provider/file-provider.ts` | 跨目錄 import                                     |

**🔴 禁止：**

- ❌ 把記憶/知識庫/維基路徑改到 `system/` 目錄內
- ❌ 移除跨目錄 import 而不提供等價替代

---

## 7. 總結：不碰原則

遇到以下程式碼區塊時，**不要「優化」或「重構」**：

| 檔案               | 區塊                                                    | 理由                |
| ------------------ | ------------------------------------------------------- | ------------------- |
| `index.ts:76`      | `if (process.env.TAILSCALE_WATCH === "off") return "";` | 輕量模式入口        |
| `index.ts:117-138` | `hasMasterIP` 角色判斷                                  | 雙機架構核心        |
| `index.ts:276-289` | `TAILSCALE_WATCH !== "off"` 保護                        | 跳過 watcher        |
| `index.ts:309-326` | `forcedMaster` 分支                                     | 跳過 peer 偵測      |
| `store.ts:224-234` | 移除了 `setTimeout(semRelease)`                         | semaphore 計數保護  |
| `api.ts` 新增端點  | knowledge/wiki/read/pull/cleanup                        | 跨機同步協議        |
| `api.ts` cleanup   | `POST /api/cleanup`                                     | hash 驗證後刪除來源 |

---

> 最後更新：2026-06-05（新增 cleanup 端點 + hash 驗證同步流程）
> 如有架構變更需要，請先諮詢使用者確認。
