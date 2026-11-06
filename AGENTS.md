# qwen2api-dev 專案規範

> 千問模型本地 API 代理系統的開發與維護指南
> 變體：dev（主要開發線）| 版本 SOP：`VERSION_SOP.md`

---

## 🖥️ 當前裝置判定（讀任何章節前先看這裡）

> 本專案同時跑在兩台機器上。**動手前先確認自己在哪台**，否則會改錯路徑、用錯啟動方式、做出錯誤的效能決策。

| 項目       | 筆電（開發機）                     | 主力機（服務機）                           |
| :--------- | :--------------------------------- | :----------------------------------------- |
| 主機名     | `reamaster-Aspire-E5-573G`         | `DESKTOP-91CKG9S`                          |
| 系統       | Linux（AnduinOS 2.0.5 / GNOME 50.1） | Windows 11（10.0.26100）                  |
| 專案根目錄 | `/home/reamaster/opencode-manager` | `D:\opencode\opencode-manager`             |
| 路徑格式   | 正斜線 `/`                         | 反斜線 `\`                                 |
| 硬體       | i5-5200U / 16GB（**仍須輕量化**）  | Xeon E5-2680 v2 / 64GB（**不需省**）       |
| 啟動方式   | `bash start.sh`                    | `start-desktop.bat` 或 `start-desktop.vbs` |
| 停止方式   | `Ctrl+C`                           | `stop-desktop.bat`                         |
| 角色定位   | 開發、改碼、測試                   | 常駐服務、對外提供模型                     |

**自我定位方法**（不要靠猜）：

```bash
# Linux
uname -s && hostname
# Windows PowerShell
[System.Environment]::OSVersion.Platform; hostname
```

**路徑規則（唯一事實來源）**：

`config/paths.js` 的 `_ROOT` 已依平台自動切換：

```js
_ROOT =
  process.env.PROJECT_ROOT ||
  (_IS_WIN
    ? "D:\\opencode\\opencode-manager"
    : join(homedir(), "opencode-manager"));
```

- 要覆寫 → 設 `PROJECT_ROOT` 環境變數，**不要改原始碼**
- **禁止**在業務邏輯硬編碼 `D:\...` 或 `/home/...`，一律從 `paths.js` 取

**⚠️ 殘留路徑陷阱（絕對禁止使用）**：

| 錯誤路徑                             | 真相                                                                     |
| :----------------------------------- | :----------------------------------------------------------------------- |
| `D:\Tools\opencode\opencode-manager` | **舊版殘留**，雖有目錄結構但不是執行路徑，改這裡不生效                   |
| `~/.openclaw/memory/lancedb-pro`     | 舊記憶路徑殘留（8K），真正資料在 `projects/.opencode/memory/lancedb-pro` |

> 判斷「哪個才是真的」→ 用 `Get-CimInstance Win32_Process` 查 `CommandLine`，或看 `ss -ltn` 對應的進程工作目錄。**不要相信目錄存在就代表是對的**。

---

## 目錄結構

```
qwen2api-dev/
├── qwen2api/                        # 核心服務（port 3000）
│   ├── scripts/token-usage.sh        # 🆕 Token 花費查詢（權威來源）
│   └── src/
│       ├── server.js                # Express 主服務
│       ├── controllers/chat.js      # SSE 串流處理
│       ├── controllers/models.js    # 模型列表
│       ├── config/index.js          # 設定
│       ├── routes/                  # 路由
│       └── utils/
│           ├── chrome-fetch.js      # Chrome Fetch Proxy（WAF 繞過）
│           ├── request.js           # 上游請求 + 帳戶輪換
│           ├── data-persistence.js  # 持久化設定
│           └── ssxmod-manager.js    # Cookie 管理器
├── qwen2api-plugin/                 # opencode 插件 + chat-proxy（port 3456）
│   └── src/
│       ├── index.js                 # 插件入口（19 工具）
│       ├── chat-proxy.js            # 聊天代理（3389 行）
│       ├── start-proxy.js           # Proxy 啟動器
│       ├── evolution-engine.js      # evolution-engine.js（自動權重/路由調整）
│       ├── self-learning.js         # 自我學習系統
│       ├── auto-judge.js            # 經驗自動判斷
│       ├── hardware-detect.js       # 硬體偵測
│       ├── platform.js              # 跨平台工具
│       ├── resolve-deps.mjs         # 共享依賴修復
│       └── color.js                 # 🆕 統一色彩系統（TrueColor/語義色/標籤色）
├── telegram-memory-bridge/          # Telegram 記憶橋接（port 4377）
│   ├── src/index.ts                 # Bot 主入口
│   ├── src/store.ts                 # 記憶儲存
│   ├── src/sync-cli.ts             # 同步 CLI
│   └── test/                        # 測試
├── knowledge-wiki-plugin/           # 知識庫/維基/教訓插件
│   └── src/
│       ├── index.ts                 # 插件主入口
│       ├── tools.ts                 # 工具註冊
│       ├── provider/                # Provider 實現
│       ├── types/                   # 型別定義
│       └── provider-manager.ts      # Provider 管理器
├── config/
│   ├── paths.js                     # 跨裝置路徑集中管理
│   └── ... (部分在 qwen2api-plugin/src/config/)
├── .opencode/
│   └── lesson-learned/              # 專案本地教訓快取
├── logs/                            # 運行日誌
│
├── 啟動與配置
│   ├── start.mjs                    # 統一啟動器（880 行）
│   ├── start.sh                     # 啟動腳本 wrapper
│   ├── config.json                  # 服務定義清單
│   ├── .env                         # 環境變數
│   └── refresh-token.js             # Token 自動更新
│
├── 文件
│   ├── ARCHITECTURE.md              # 系統架構
│   ├── AGENTS.md                    # 🆕 本文件（AI 行為規範）
│   ├── TROUBLESHOOT.md              # 滯留訊息診斷手冊
│   ├── VERSION_SOP.md               # 版本 SOP
│   ├── MILESTONES.md                # 里程碑
│   ├── ROADMAP.md                   # 路線圖
│   └── README.md                    # 專案說明
│
├── 工具腳本
│   ├── tailscale.sh                 # Tailscale 安裝
│   ├── sync-to-desktop.sh           # 筆電→桌機同步
│   └── test_stall.sh                # 停頓診斷

```

---

## 跨裝置定義（重要，避免誤解）

> ⚠️ **跨裝置 = 本機執行路徑依當前裝置自動切換（Linux / Windows / Mac），不是網路連線。**
>
> | 項目               | 說明                                                                                                |
> | ------------------ | --------------------------------------------------------------------------------------------------- |
> | **跨裝置是什麼**   | 本機路徑依 `os.platform()` 自動切換：Linux 用 `/home/...`、Windows 用 `D:\...`、Mac 用 `/Users/...` |
> | **跨裝置不是什麼** | ❌ 不是對外服務、❌ 不是跨裝置網路連線、❌ 不是遠端代理                                             |
> | **所有模型服務**   | qwen2api:3000、chat-proxy:3456 = **本機代理**，綁 `127.0.0.1`，不對外                               |
> | **唯一對外**       | Telegram Bot (4377) 綁 `0.0.0.0`，Tailnet 內節點推送→主機拉取                                       |
> | **偵測來源**       | `TARGET_OS` 環境變數 > `process.platform`                                                           |
> | **實作位置**       | `config/paths.js` 的 `getTargetOS()`、`config/models.js` 的 `getDeviceInfo().targetOS`              |
> | **路徑切換**       | `paths.js` 的 `_IS_WIN` 依 `getTargetOS()` 決定，win 用 `D:\`/backslash，linux/mac 用 `/`           |
> | **非遠端**         | 不監聽外部連接、不提供其他裝置連入；`sync-to-desktop.sh` 為手動同步腳本，非代理功能                 |

**誤解防範**：

- 原 `getDeviceInfo()` 僅偵測 laptop/desktop（電池/CPU/RAM）與 `process.platform`，未涵蓋「使用者目標系統」語意。2026-07-13 已完善：`getTargetOS()` 為單一事實來源。
- 2026-07-20 確認：所有硬編碼 `/home/reamaster` 已改為 `os.homedir()` 動態取得。
- 2026-10-25 修正：本文件曾把同步目標誤寫為 `D:/Tools/opencode/opencode-manager`（實際為 `D:/opencode/opencode-manager`），已修正並加註殘留目錄警告。若發現 `src/` 有硬編碼 `D:\` 或 `/home/`，以 `config/paths.js` 為準並回報。

---

## 開發環境

### 硬體規格（雙機對照）

| 項目 | 筆電（開發機）         | 主力機（服務機）             |
| :--- | :--------------------- | :--------------------------- |
| CPU  | i5-5200U（2C4T，老舊） | Xeon E5-2680 v2（20 執行緒） |
| RAM  | 16GB + 2GB swap + 7.8GB zram | 64GB（實際可用 ~46GB）  |
| OS   | AnduinOS 2.0.5（GNOME 50.1，Kernel 7.0.0-38） | Windows 11（10.0.26100） |
| 角色 | 開發、改碼、測試       | 常駐服務、對外提供模型       |

> 硬體判斷會影響逾時與併發設定（`config/index.js` 的 `DEVICE_ROLE` 依 CPU 型號自動判定：Xeon → `server`）。
> **不要用筆電的規格去推論主力機**，反之亦然。

### 輕量化配置（**僅筆電適用**）

> ⚠️ 本節只適用筆電（i5-5200U / 16GB）。主力機 64GB **不需要**以下限制，套用反而降低吞吐。

所有筆電開發操作必須考慮輕量化，避免系統負擔：

| 原則                       | 說明                                                  | 主力機是否適用  |
| -------------------------- | ----------------------------------------------------- | --------------- |
| `LIGHTWEIGHT=true`（預設） | Chrome `--single-process` 模式，記憶體節省 60-70%     | ❌ 不建議       |
| 避免多進程                 | Chrome 預設多進程架構會產生 9 個子進程、吃 ~1.2GB RAM | ❌ 不需要       |
| 錯誤只進 log               | 所有錯誤訊息僅寫 log，不進對話框（已修復）            | ✅ 通用         |
| 定期清理                   | Chrome 孤兒進程、暫存檔案用完即清                     | ✅ 通用         |
| `TAILSCALE_WATCH=off`      | 筆電模式跳過 tailscale 輪詢，省 fork 開銷             | ❌ 主力機需開啟 |

### 啟動方式

```bash
# 🏆 一鍵啟動全部服務（qwen2api + proxy + telegram-bridge + 健康檢查）
bash start.sh              # 或右鍵以程式執行
# 等同於:
node start.mjs             # normal - 顯示服務狀態

# 也可用 bun run dev（需根目錄 package.json）
bun run dev                # normal
bun run dev:verbose        # verbose - debug 模式
bun run dev:quiet          # quiet  - 全進日誌
bun run dev:log            # 查最近停止事件

# 單獨啟動特定服務
cd qwen2api && bun src/start.js                    # 僅 qwen2api
cd qwen2api-plugin && bun src/start-proxy.js       # 僅 proxy
cd telegram-memory-bridge && bun src/index.ts       # 僅 telegram
```

### 重啟授權（測試用，2026-11-05 使用者授權）

> **部分重啟可直接執行，不需先問**，方便測試。

| 類型 | 範圍 | 授權 |
| --- | --- | --- |
| 部分重啟（單一服務） | qwen2api :3000、chat-proxy :3456、telegram-bridge :4377 等 | ✅ 直接執行 |
| 完整重啟 | `node start.mjs` / `bun dev` 全部服務、含 Chrome/WAF 冷啟動 | ⚠️ 先確認 |

```bash
# 部分重啟（SIGTERM，start.mjs 看門狗 code!==0 → 3s 自動重拉）
kill -TERM $(ss -ltnp | grep ':3456' | grep -oP 'pid=\K[0-9]+')   # chat-proxy
kill -TERM $(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+')   # qwen2api
sleep 7 && curl -s -m 5 http://127.0.0.1:3456/health              # 驗證
```

- **禁止 kill -9**（會留 Chrome 孤兒子程序）；一律 SIGTERM。
- 服務跑 `src/`，改 src 免重建 `dist/`。
- 完整重啟才需先確認；部分重啟失敗（未自動重拉）才手動 `bun src/start-proxy.js`。

### 一鍵啟動（Windows 桌機）

```bash
# 背景執行（recommended）
start-desktop.bat     # 有視窗可觀察進度
start-desktop.vbs     # 完全靜默後台

# 停止
stop-desktop.bat
```

### 一鍵啟動（tmux）

```bash
./start-tmux.sh       # 開新 tmux session 跑服務
```

### 依賴管理

```bash
# 各子專案獨立安裝依賴
cd qwen2api && bun install
cd qwen2api-plugin && bun install
cd telegram-memory-bridge && bun install
cd knowledge-wiki-plugin && bun install
```

### 服務依賴順序

```
qwen2api（3000）← chat-proxy（3456）← opencode 工具呼叫
                                    ← telegram-bridge（4377，選用）
```

- qwen2api 必須先啟動（chat-proxy 啟動時會檢查 upstream）
- telegram-bridge 依賴 qwen2api-plugin 的路徑配置（config/paths.js）

---

## 插件工具清單（19 個）

`qwen2api-plugin/src/index.js` 註冊以下工具：

### 檔案操作

| 工具         | 功能             | 底層        |
| ------------ | ---------------- | ----------- |
| `qwen_read`  | 讀取檔案內容     | MCP `read`  |
| `qwen_write` | 寫入/建立檔案    | MCP `write` |
| `qwen_edit`  | 檔案尋找取代     | MCP `edit`  |
| `qwen_glob`  | 通配符搜尋檔案   | MCP `glob`  |
| `qwen_grep`  | 檔案內容正則搜尋 | MCP `grep`  |
| `qwen_bash`  | 執行 shell 命令  | MCP `bash`  |

### 生態查詢

| 工具               | 功能             | 底層               |
| ------------------ | ---------------- | ------------------ |
| `qwen_skill_list`  | 列出所有可用技能 | MCP `skill_list`   |
| `qwen_skill_read`  | 讀取指定技能內容 | MCP `skill_read`   |
| `qwen_wiki_search` | 搜尋知識庫/維基  | MCP `wiki_search`  |
| `qwen_wiki_read`   | 讀取維基頁面     | MCP `wiki_read`    |
| `qwen_memory`      | 查詢記憶系統     | MCP `memory_query` |

### 服務管理

| 工具                 | 功能                                 | 底層                    |
| -------------------- | ------------------------------------ | ----------------------- |
| `qwen_health`        | 服務健康狀態（記憶體/帳戶/運行時間） | `GET /health`           |
| `qwen_repair`        | 自我修復（依賴檢查/目錄建立/GC）     | `POST /health/repair`   |
| `qwen_token`         | Token 狀態檢查與更新指引             | `GET /health`           |
| `qwen_diagnose`      | 完整診斷（建議優先使用）             | `POST /repair/diagnose` |
| `qwen_proxy_status`  | Chat Proxy 狀態（模式/路由/降級）    | `GET /health` (proxy)   |
| `qwen_repair_manual` | 維修手冊查詢                         | `GET /repair/manual`    |

> 所有工具走 chat-proxy（3456），Direct 模式下僅 `qwen_health/qwen_proxy_status` 可用。
> 工具不會阻塞插件載入 — 背景異步啟動服務。

---

## 同步桌面機制

```bash
# 筆電(Linux) → 桌機(Windows)
bash sync-to-desktop.sh            # 執行同步
bash sync-to-desktop.sh --dry-run  # 預覽模式
```

| 屬性     | 值                                         |
| -------- | ------------------------------------------ |
| 傳輸     | tar pipe SSH（單次連線）                   |
| 遠端主機 | `ReaMasTer@100.71.40.106`（Tailscale IP）  |
| 來源     | `/home/reamaster/opencode-manager`         |
| 目標     | `D:/opencode/opencode-manager`             |
| 同步清單 | store.ts, index.js, paths.js, AGENTS.md 等 |

> ⚠️ **路徑陷阱**：目標是 `D:/opencode/opencode-manager`（**無 `Tools`**）。
> `D:\Tools\opencode\opencode-manager` 是**舊版殘留目錄，禁止使用**——裡面雖有 `projects/{.opencode,independent,system}` 與 `scripts` 結構，但不是執行路徑，改那裡不會生效。
> 驗證方式：`Get-CimInstance Win32_Process -Filter "Name='bun.exe'"` 看 `CommandLine` 的實際路徑。

### 同步清單更新方式

```bash
# 編輯 sync-to-desktop.sh 的 FILES 陣列
FILES=(
  projects/independent/qwen2api-dev/telegram-memory-bridge/src/store.ts
  projects/independent/qwen2api-dev/qwen2api-plugin/src/index.js
  # ... 新增檔案路徑
)
```

---

## 新增服務指引

若需在 `start.mjs` 中新增服務，遵循以下步驟：

1. **定義服務配置**：在 `start.mjs` 的 `SRV` 陣列中加入：

   ```javascript
   {
     name: "my-service",
     port: 4000,
     cwd: join(ROOT, "my-service"),
     cmd: [BUN, "src/index.js"],
     env: { ...process.env },
     waitUrl: "http://127.0.0.1:4000/health",
     waitTimeout: 15,
     skip: !process.env.MY_SERVICE_ENABLED,  // 條件啟用
   }
   ```

2. **更新 config.json**：在 `services` 陣列中加入對應條目
3. **更新 ARCHITECTURE.md**：子專案表 + 目錄結構
4. **更新 AGENTS.md**：目錄結構 + 啟動順序（若依賴其他服務）
5. **同步雙機**：更新 `sync-to-desktop.sh`

---

## 診斷流程（問題時優先使用）

```
問題發生
  │
  ├── Step 1: 確認服務狀態
  │     curl -s http://127.0.0.1:3000/health
  │     curl -s http://127.0.0.1:3456/health
  │
  ├── Step 2: 執行工具診斷
  │     對話中呼叫 qwen_diagnose → 自動檢查所有已知問題
  │
  ├── Step 3: 找 TROUBLESHOOT.md
  │     依症狀查 §A-§Z 對照表
  │
  ├── Step 4: 執行 test_stall.sh
  │     精確測量各階段耗時
  │
  └── Step 5: 完整重啟
        kill -9 $(lsof -ti :3000,3456,4377)
        rm -f /tmp/qwen2api-dev.pid
        ./start.sh
```

### Token 花費查詢（發一次對話花多少 tokens）

> 權威來源 = **qwen2api(3000) 的 log**。chat-proxy(3456) 與 opencode session DB 都只是轉發／自身記錄，數字不準。

```bash
# 最近 N 筆統計
bash qwen2api/scripts/token-usage.sh 10

# 累計 + 平均
bash qwen2api/scripts/token-usage.sh --summary

# 原始寫法
grep -ahE "使用tiktoken計算|使用上游真實Token" logs/run-*/qwen2api.log | tail -1
```

| 事實              | 說明                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| log 關鍵字        | `📝 流式/非流式使用tiktoken計算` 或 `使用上游真實Token` → `Prompt / Completion / Total`     |
| 計算方式          | 優先用上游 `usage`，否則 `utils/precise-tokenizer.js` 的 tiktoken 估算                      |
| prompt 遠大於提問 | proxy 每輪注入工具清單、認知提示、persona、對話摘要（見 chat-proxy log `ctx=XXXXch`）       |
| ⚠️ 誤區           | `~/.local/share/opencode/opencode-stable.db` 的 `qwen-proxy/*` 訊息 tokens 多為 0，不可採用 |

---

## 知識預讀規則（硬性規定）— 優先於所有其他操作

> 執行任何修改前先查 lesson+wiki，完成修改後須建新紀錄並同步維基索引。

```
進入專案 → 先以專案名查知識庫建立印象（Glob skill/lesson/*專案名* + Grep wiki-index.json 專案名）
修改前   → Glob skill/lesson/*關鍵字* + Grep wiki-index.json → 關鍵字（日期輔助定位時間線）
修改後   → 建新檔 skill/lesson/YYYY-MM-DD-HHmm-slug.md（禁止改舊檔，日期標題幫助追溯）
紀錄後   → 更新 wiki-index.json（entries + links），不進 knowledge-autosave
```

未查前例=重複踩坑，未記lesson=查不到修過什麼，未同步wiki=搜不到。

### 混亂自救（優先於問用戶）

感到混亂、不確定、或「一問三不知」時，**先查工具再問人**：

```
1. memory_recover / memory_recall → 查對話歷史與記憶
2. qwen_wiki_search → 查維基索引
3. Glob skill/lesson/*關鍵字*    → 查 lesson 紀錄
4. 以上皆無 → 再問用戶
```

### 路徑防呆（不靠記憶力）

```
1. 操作檔案前先用 ls/glob 確認目錄存在
2. 有 user 提供的路徑 → 直接用，不要自己拼
3. 自己拼路徑時 → 每層路徑都用 ls 確認再往下
4. 發現路徑不存在 → 用 glob 找正確位置，不要猜
```

### 除錯紀律（避免誤判主因）

**誤會主因是最大的風險。修錯比不修更糟。**

```
1. 先收集證據，再推論原因
   → 至少兩種獨立證據指向同一結論，才接受

2. 推論後先確認再動手
   → 把「我認為原因是...，打算修...」說清楚
   → 等確認後才改程式

3. 一次只改一個變數
   → 同時改多處 = 無法確認哪個有效
   → 也無法回滚

4. 修完後驗證
   → 確認症狀消失
   → 確認沒引入新問題

5. 發現問題就修，禁止「根本次修改無關」藉口
   → 除錯過程中發現任何 BUG 或異常，必須一併修復
   → 禁止以「跟本次修改無關」為理由推託不修
   → 修一個問題順手修三個問題 = 省三倍時間
   → 如果真的不影響功能且無害，明確說「此問題不影響運作，暫不處理」而非「根本次修改無關」

6. 測試遇到問題是常態，心態正確才能修完
   → 發現問題 → 評估嚴重性 → 高的立即修，低的記錄後繼續
   → 問題修不完是正常的，停下來不修才不正常
   → 每次測試遇到的問題都是改進機會，別浪費
   → 不影響本專案的問題 → 紀錄提報 bug，不追究誰造成的
   → 「暫不處理」的問題必須有明確追蹤（lesson / TODO），不能丟進黑洞
```

知識庫、記憶、lesson 建了就是要用的。不先查就慌 = 白建了。

### 提問限制（避免打斷使用者）

```
1. 能用工具查到的 → 不問
2. 規則已寫清楚的 → 不問
3. 可推論得出的   → 不問
4. 真的非問不可   → 一次問完，不要連續問
```

問問題是把混亂轉嫁給使用者。查工具才是解決混亂的正確手段。

---

## 語義邊界（防止模型誤解）

- 「自主／主動／自我」＝在任務、工具權限、使用者授權內自動選擇下一步；不是意識、情感、獨立目標或人格。
- 「自我學習／自我修復」＝自動記錄、分析、切換路徑或呼叫修復工具；不是自我成長、自我意識或生存本能。
- 授權外、不可逆、對外操作先確認；可回報但不自行擴大執行範圍。

## AI 自動追溯行為（自動記錄判斷）

> 模型依當前任務、工具與規則判斷「是否記錄、記錄什麼、記在哪」，不依賴固定模板；不代表有獨立意志。

### 修改前：理解脈絡

1. 讀取 `AGENTS.md` + `ARCHITECTURE.md`，理解不變邊界
2. 確認修改是否涉及危險區（`projects/system/` — 🔥 絕對禁止存放資料）
3. 自行評估：本次任務的 scope、風險、是否牽涉已知不變邊界

### 自動記錄判斷框架

每次分析或修改完成後，模型自行回答以下問題來決定行為：

| 問題                         | 是 →                            | 否 → |
| ---------------------------- | ------------------------------- | ---- |
| 學到新技術或解決了難題？     | 寫入 lesson（安全區）+ 本地快取 | 跳過 |
| 修復過程可複用、值得參考？   | 更新 wiki（安全區）             | 跳過 |
| 發現了跨對話適用的關鍵事實？ | 儲存記憶（安全區）              | 跳過 |
| 變更了系統架構/行為？        | 更新 ARCHITECTURE.md            | 跳過 |
| 新增了常見問題型態？         | 更新 TROUBLESHOOT.md            | 跳過 |

判斷原則：

- **寧缺勿濫**：只有真正有價值的才記錄；純語法修正、trivial 改動直接跳過
- **不重複**：若已有相似記錄，更新現有條目而非新建
- **就地判斷**：不需使用者提醒，也不需請示確認
- **安全第一**：所有記錄存安全區（`projects/.opencode/`），嚴禁存 system/

### 三區安全模型（絕對死律）

| 區域          | 路徑                    | 行為                                                         |
| ------------- | ----------------------- | ------------------------------------------------------------ |
| ✅ **安全區** | `projects/.opencode/`   | 知識庫、維基、教訓、記憶 → 存放於此                          |
| 🔥 **危險區** | `projects/system/`      | 翻車即刪，嚴禁存放任何重要資料                               |
| ❌ **隔離區** | `projects/independent/` | 環境隔離，lesson 僅可本地快取（`.opencode/lesson-learned/`） |

> 所有重要記錄「必須」存安全區 `projects/.opencode/`，嚴禁只存本地。
> 本地快取位置：`.opencode/lesson-learned/`（僅供離線參考，非主要儲存）

---

## 🚫 啟動界面鎖定（絕對禁止修改）

> 防止 AI 模型在修復問題時意外改動 `start.mjs` 的啟動輸出格式與內容。

`start.mjs` 中標記為 `// 🚫 LOCKED` 的所有輸出區塊，進行任何修復/修改時**不得**變更其：

- **格式**：prefix、縮排、間隔符、分隔線（`──`）
- **內容**：文字訊息、emoji、欄位名
- **順序**：各區塊的輸出先後順序
- **色彩**：若未來加入顏色，不得修改色碼

### 鎖定區塊清單

| §   | 區塊          | 位置                                | 不變內容                                 |
| --- | ------------- | ----------------------------------- | ---------------------------------------- |
| §1  | `slog()` 格式 | L35-42（`[timestamp] [start] msg`） | 時間戳 + `[start]` prefix 格式           |
| §2  | 開場橫幅      | `main()` 開頭 2 行                  | `[INFO]` 兩行開場文字                    |
| §3  | 服務啟動日誌  | `launch()` exit handler             | `${name} 已啟動 (PID: ${pid})` 格式      |
| §4  | 健康報告      | `genReport()` return                | `${pct}% \| svc1 svc2 \| model` 單行摘要 |
| §5  | 硬體報告      | `hwReport()`                        | 🖥💾🔌🌐📊🤖 欄位順序與格式              |
| §6  | 服務摘要      | `main()` 中段                       | URL 列表格式 + 4 空格縮排                |
| §7  | 功能特徵列表  | `main()` 中段                       | emoji + 功能名 + 說明                    |
| §8  | 知識工具狀態  | `main()` 中段                       | 三圖示 + 標籤格式                        |
| §9  | 運行中心跳    | `setInterval` 300s                  | 間隔及 `${icon} 運行中 \| ...` 格式      |

### 修改流程（如需變更啟動界面）

任何啟動界面的變更必須：

1. 先與使用者確認（不可自行決定）
2. 同步更新此鎖定清單
3. 寫入 lesson 紀錄
4. 同步 wiki 索引

---

## 不變邊界（禁止修改）

| 邊界                      | 說明                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `start.mjs`               | 啟動邏輯（埠管理、子進程、健康檢查）不得改為同步阻塞                        |
| `chrome-fetch.js`         | `headless: false` 不得改為 `true`（WAF 繞過需要）                           |
| `processor.ts` catch 區塊 | `continue` 改為 `return "stop"`（已修復，禁止改回）                         |
| `config/paths.js`         | 跨裝置路徑唯一真相來源，不得分散管理                                        |
| `chat-proxy.js` 錯誤處理  | 不 `process.exit()`，應 keepalive                                           |
| `start-proxy.js` 啟動重試 | 失敗 3 次後保持程序活著，不強制離開                                         |
| `start.mjs` port cleanup  | 不得無差別殺埠（只能用 PID 檔追蹤自身進程）                                 |
| 插座清理原則              | 永不主動殺 systemd / PM2 或其它專案服務                                     |
| `.ai-variant`             | dev 變體標記，禁止混入 dev2 專屬功能                                        |
| **跨裝置路徑**            | 🔥 禁止硬編碼 `/home/reamaster` 或任何使用者名稱，一律用 `os.homedir()`     |
| **服務綁定**              | 🔥 qwen2api/chat-proxy 綁 `127.0.0.1`（本機），僅 Telegram Bot 綁 `0.0.0.0` |
| **跨裝置 ≠ 對外連線**     | 🔥 跨裝置是本機路徑切換（Linux/Win/Mac），不是網路連線或對外服務            |

## 跨子專案檔案關聯

| 檔案                 | 被誰引用                                                        |
| -------------------- | --------------------------------------------------------------- |
| `config/paths.js`    | `knowledge-wiki-plugin/src/index.ts`, `telegram-memory-bridge/` |
| `start.mjs`          | 直接執行                                                        |
| `.env`               | `start.mjs` 載入 → 傳遞給所有子進程                             |
| `config.json`        | IDE / 外部工具解析服務清單                                      |
| `sync-to-desktop.sh` | 手動執行同步                                                    |

---

## 故障排除索引

| 問題            | 文件                                               |
| --------------- | -------------------------------------------------- |
| 對話框滯留訊息  | `TROUBLESHOOT.md`                                  |
| Chrome 孤兒進程 | `TROUBLESHOOT.md §A` → `kill -9 $(lsof -ti :3000)` |
| 記憶體不足      | 啟用 `LIGHTWEIGHT=true`                            |
| 連接拒絕        | 檢查 `curl :3000/health` + `curl :3456/health`     |

## 知識參考索引

| 主題                           | 位置                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Chrome 孤兒進程根因與修復      | `projects/.opencode/skill/lesson/2026-06-30-chrome-orphan-process-cleanup.md`           |
| Session stderr 滯留訊息隔離    | `projects/.opencode/skill/lesson/2026-06-30-session-stderr-sanitization.md`             |
| Chrome WAF 繞過技術            | `projects/independent/qwen2api-dev/.opencode/lesson-learned/chrome-fetch-waf-bypass.md` |
| 開發機輕量化與錯誤隔離完整記錄 | `projects/.opencode/wiki/03-問題修復/Qwen2API-開發機輕量化與錯誤隔離.wiki`              |
| 記憶條目                       | `projects/.opencode/memory/entries/mem-20260630-qwen2api-dev-fixes.md`                  |

## 防一問三不知（新進 AI 必讀）

當使用者問到以下問題時，**先查 ARCHITECTURE.md 再回答**，不要說「我沒有上下文」：

| 問題類型                 | 查哪                                          |
| ------------------------ | --------------------------------------------- |
| 「現在系統狀態？」       | `ARCHITECTURE.md → 目前狀態`                  |
| 「改過什麼？」           | `ARCHITECTURE.md → 修改追蹤清單`              |
| 「為什麼這樣改？」       | `ARCHITECTURE.md → 修改追蹤清單 → 原因欄`     |
| 「升級本源要注意什麼？」 | `ARCHITECTURE.md → 修改追蹤清單 → 是否可撤回` |
| 「還有什麼問題？」       | `ARCHITECTURE.md → 目前狀態 → 已知問題`       |
| 「上次做了什麼？」       | `ARCHITECTURE.md → 變更紀錄（時間序）`        |

> > 若查完仍不知，誠實說「文件中沒有記錄，需要實測確認」，不要瞎編。

### 對話結束時自動更新

每次對話結束前（使用者表示完成或無後續問題時），AI 依規則判斷是否需要更新 `ARCHITECTURE.md`：

| 情況              | 更新哪                                          |
| ----------------- | ----------------------------------------------- |
| 這次修改了程式碼  | → `ARCHITECTURE.md → 修改追蹤清單` + `變更紀錄` |
| 發現新的已知問題  | → `ARCHITECTURE.md → 目前狀態 → 已知問題`       |
| 服務健康度有變化  | → `ARCHITECTURE.md → 目前狀態 → 服務健康度`     |
| 僅查詢/無任何變更 | → 跳過，不更新                                  |

更新原則：**只追加不刪除**，保留歷史軌跡。日期標記為當天。

## 快速 SQL / 搜尋

```bash
# 搜尋所有子專案中的關鍵字
grep -r "YOUR_KEYWORD" --include="*.{js,ts,cjs,mjs}" qwen2api/ qwen2api-plugin/ telegram-memory-bridge/ knowledge-wiki-plugin/

# 搜尋特定日期的日誌
ls logs/run-*/qwen2api.log | head -1 | xargs tail -100

# 檢查所有子專案的 package.json 版本
grep -A1 '"version"' qwen2api/package.json qwen2api-plugin/package.json telegram-memory-bridge/package.json knowledge-wiki-plugin/package.json
```

## 最後更新

2026-07-03: 新增「防一問三不知」章節（新進 AI 查閱 ARCHITECTURE.md 的指引表）
2026-07-03 (v2): content:null 滯留根治 — response builders 省略 content 鍵，streaming error 不送 chunk，純文字串流跳過空內容

2026-07-09: 追加「對話中斷四層根因」+「bash 工具卡住真正元兇（platform.js timer is not defined）」，與 ARCHITECTURE.md 對話中斷節對齊

2026-06-30：初版建立，涵蓋開發環境規範、AI 自動追溯行為、不變邊界、工具清單、同步機制、診斷流程

---

## 🆕 統一色彩系統（2026-07-02 新增）

### 檔案位置

- `qwen2api-plugin/src/color.js` — 核心模組

### 引入方式（所有模組統一模式）

```javascript
import { color, supportsColor } from "./color.js";
const USE_COLOR = supportsColor();
const c = USE_COLOR
  ? color
  : {
      /* fallback 純文字 */
    };
const log = {
  info: (...a) => console.log(c.tag("tag"), c.level("info"), c.info(...a)),
  warn: (...a) => console.warn(c.tag("tag"), c.level("warn"), c.warn(...a)),
  error: (...a) => console.error(c.tag("tag"), c.level("error"), c.error(...a)),
  sysError: (...a) =>
    console.error(c.tag("系統"), c.bold(c.error("[系統錯誤]")), c.error(...a)),
};
```

### 已整合模組（12 個）

| 檔案                      | 標籤          | 用途             |
| ------------------------- | ------------- | ---------------- |
| `chat-proxy.js`           | `proxy`       | 主代理服務       |
| `start-proxy.js`          | `proxy`       | 啟動器           |
| `index.js`                | `plugin`      | 插件主入口       |
| `provider/router.js`      | `router`      | 多 Provider 路由 |
| `self-learning-plugin.js` | `learning`    | 學習插件         |
| `evolution-engine.js`     | `evolution`   | 進化引擎         |
| `provider/auth/index.js`  | `auth`        | Auth 工廠        |
| `provider/auth/oauth.js`  | `auth:oauth`  | OAuth 認證       |
| `provider/auth/cookie.js` | `auth:cookie` | Cookie 認證      |
| `provider/index.js`       | `provider`    | Provider 匯出    |
| `provider/provider.js`    | `provider`    | Provider 基類    |
| `auto-judge.js`           | `auto-judge`  | 自動判斷         |
| `hardware-detect-cli.js`  | `hardware`    | 硬體偵測 CLI     |

---

## 2026-07-07 停滯修復記錄

### 問題分析

模型在建立檔案/程式碼時突然停滯不執行，對話框空白無任何回應。

### 根因 (4 項)

| #   | 根因                                                                        | 說明                                                     | 修復                                                         |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `_extractFilePath` 回傳 `null` 時 `nonBashBlockToToolCalls` 靜默 `continue` | 模型輸出的程式碼區塊無法推斷路徑就被丟棄，對話框空白     | 加入 fallback 路徑 `src/generated/file.{ext}`，永不回傳 null |
| 2   | `_isStalling(s.length < 5)` 將「好的」「Done」誤判為停滯                    | 合法簡短確認詞觸發矯正機制，浪費時間又混淆模型           | 加入合法確認詞白名單 + 工具活躍上下文判斷                    |
| 3   | `cur.includes(prev) \|\| prev.includes(cur)` 過於寬鬆                       | `"bun run dev".includes("bun")` 誤判為重複，中止命令執行 | 移除 substring 比對，改為同命令首詞 prefix 匹配（minLen≥4）  |
| 4   | 未知語言區塊無任何輸出（無 log、無 fallback）                               | 模型輸出非標準語言標籤時檔案建立永遠不執行               | 加入 `log.warn` 警告，確保可排查性                           |

### 三痛點共振

這三個問題會串聯加劇：模型輸出程式碼→路徑推斷失敗靜默跳過→對話框空白→模型說「好的」→誤判停滯觸發矯正→浪費更多時間→最終看起來像完全卡死。

### 2026-07-09 補充：bash 工具卡住的真正元兇

除上方 4 項外，發現 `platform.js` 的 `execShellAsync` 在 `finish`/`catch` 中參考了**未宣告的 `timer`**（實際變數為 `_timer`，且作用域僅在 `spawn` 之後）。結果：**每次執行 `qwen_bash` 工具都拋 `timer is not defined`**，但被 proxy 的 keepalive 未捕捉例外機制吞掉，對話框看起來像「指令發出去卻無回應 / 卡住」。

| #   | 根因                                                 | 修復                                                                                                     |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 5   | `finish`/`catch` 引用不存在的 `timer`（Typo/作用域） | 將 `let _timer;` 提升至 Promise 頂層作用域，`finish`/`catch`/`close`/`error` 統一 `clearTimeout(_timer)` |

> 此 bug 會讓「上游模型 Qwen3.6-Max-Preview 傳回空白」類的錯誤在每次 bash 呼叫時反覆噴出「未捕捉 exception: timer is not defined」，是中斷體感的主要加劇因子。

### 2026-07-09 補充二：DashScope 額度耗盡導致對話忽然停止（核心主因）

`qwen2api/src/utils/request.js` 的 DashScope 路徑是 WAF 繞過的首選，但原 `_dsUnavailableModels` 為**永久 Set**：當 `qwen-plus`/`qwen-flash` 免費額度耗盡（`insufficient_quota` 403），模型被永久封鎖，且 DashScope 路徑優先於 WAF 路徑 → 整條鏈失效 → 降級 WAF 又遇阻擋 → **對話忽然停止 / 工作中停止**。

| #   | 根因                                                | 修復                                                                            |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| 6   | `_dsUnavailableModels` 永久 Set，額度耗盡被永久封鎖 | 改為帶 TTL(5min) 的 Map，額度恢復後自動重試                                     |
| 7   | `tryModels` 掃描順序未優先 max                      | target 非 max 時將 `qwen-max` 提至第一優先，任何層級請求自動升到可用的 qwen-max |

> 實測：`qwen-max` 金鑰有效且繞過 WAF 穩定；`qwen-plus`/`qwen-flash` 額度耗盡。修復後 plus/flash 請求會自動提升試 max，不再觸發對話停止。詳見 ARCHITECTURE.md → 對話中斷根因與對策（Fix 35）。

### 對話中斷四層根因（速查）

| 層級 | 根因                       | 現象                               | 最徹底解法             |
| ---- | -------------------------- | ---------------------------------- | ---------------------- |
| 1    | 上游 WAF 全域空內容        | 模型回空、proxy 跳重試、對話框停滯 | 設 `DASHSCOPE_API_KEY` |
| 2    | DashScope 403 / 模型不可用 | 連續 403 降級                      | 設 `DASHSCOPE_API_KEY` |
| 3    | Chrome 逾時 / SSE 黑洞     | `createChat 逾時`、SSE 降級略過    | 設 `DASHSCOPE_API_KEY` |
| 4    | proxy 連敗 3 次→Direct     | MCP 工具失效                       | 監控 30s 自動切回      |

> 設了官方金鑰可一次消除 1/2/3 層（繞過 WAF），是最優先建議。詳見 ARCHITECTURE.md → 對話中斷根因與對策。

### 關鍵特性

- **`[系統錯誤]` 紅色加粗**：`c.bold(c.error("[系統錯誤]"))` — 極難被忽略
- **語義色**：對應 opencode theme（primary/secondary/accent/success/warning/error/info）
- **標籤著色**：proxy=藍、系統=灰、router=青、auth=綠、learning=綠、evolution=紫
- **等級著色**：DEBUG=灰、INFO=青、WARN=黃、ERROR=紅
- **自動環境偵測**：`FORCE_COLOR` / `NO_COLOR` / `TERM` / TTY，無色環境自動降級
- **TrueColor 支援**：24-bit RGB（`\x1b[38;2;r;g;bm`）

### 環境變數

| 變數              | 預設   | 說明                                     |
| ----------------- | ------ | ---------------------------------------- |
| `PROXY_LOG_LEVEL` | `warn` | 日誌等級（silent/error/warn/info/debug） |
| `FORCE_COLOR`     | —      | 強制啟用色彩                             |
| `NO_COLOR`        | —      | 強制禁用色彩                             |

### 新增模組規範

若新增 `.js` 模組需輸出日誌，**必須**遵循上述引入模式，確保色彩一致性。
