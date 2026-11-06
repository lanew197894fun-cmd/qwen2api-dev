# 三層可追溯架構設計

## 問題

每次 AI 修改程式碼後，變更紀錄分散在 ARCHITECTURE.md 的更新行中，無法快速查詢：

- 某個章節經歷過哪些變更？
- 每次變更的詳細內容（before/after）是什麼？
- 這次變更有學到什麼教訓嗎？
- 相關的知識條目有哪些？

## 解決方案

建立三層可追溯架構，每層負責不同的抽象層級：

### 第 1 層：ARCHITECTURE.md 變更紀錄

- 每個章節底部新增 `### 變更紀錄` 表格
- 欄位：日期、變更內容、詳細紀錄（→ [wiki:xxx]）、相關教訓（→ [lesson:xxx]）
- 優點：一頁看完所有歷史，快速定位

### 第 2 層：Wiki 變更日誌（.wiki/）

- 每次較大變更建立一個 wiki 條目
- 內容：背景、原因、變更前後對照、驗證方式
- 優點：詳細內容不塞爆 ARCHITECTURE.md

### 第 3 層：教訓（.opencode/lesson-learned/）

- 學到教訓時寫入，並引用 ARCHITECTURE.md 章節
- 優點：預防重複犯錯

## 引用格式規範

| 方向                   | 格式                       | 說明                         |
| ---------------------- | -------------------------- | ---------------------------- |
| ARCHITECTURE.md → Wiki | `→ [wiki:entry-name]`      | 變更紀錄中引用 wiki 詳細內容 |
| ARCHITECTURE.md → 教訓 | `→ [lesson:file-name]`     | 變更紀錄中引用相關教訓       |
| ARCHITECTURE.md → 知識 | `→ [knowledge:entry-name]` | 變更紀錄中引用知識條目       |
| 教訓 → ARCHITECTURE.md | `ARCHITECTURE.md §N`       | 教訓中標註所屬章節           |
| Wiki → 知識            | `knowledge/xxx.md`         | Wiki 中引用知識條目          |

## 適用場景

| 場景     | 寫入                                           |
| -------- | ---------------------------------------------- |
| 移除功能 | Wiki（詳細日誌）+ ARCHITECTURE.md（變更紀錄）  |
| 新增功能 | Wiki（設計文件）+ ARCHITECTURE.md（新章節）    |
| Bug 修復 | Lesson（教訓）+ ARCHITECTURE.md（變更紀錄）    |
| 架構決策 | Knowledge（知識）+ ARCHITECTURE.md（規範）     |
| 翻車經驗 | Lesson（教訓）+ 可能更新 Knowledge（最佳實踐） |

## 相關檔案

- `ARCHITECTURE.md §23` — 三層追溯架構規範
- `.wiki/waf-proxy-cleanup.md` — 變更日誌範例
- `.wiki/traceability-system.md` — 本文件 wiki 版本
- `.opencode/lesson-learned/` — 教訓目錄
