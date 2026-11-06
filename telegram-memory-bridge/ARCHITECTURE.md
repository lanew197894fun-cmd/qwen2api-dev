# Telegram-Memory-Bridge 系統架構規範

> ⚠️ **給所有 AI 助手（Qwen、OpenCode、Claude 等）的強制約束**
> 以下規範定義了系統的不可變架構邊界。任何違反這些規範的修改都將破壞系統運行。
>
> **AI 預設行為：** 查看→紀錄→修復→紀錄→評價→更新 ARCHITECTURE.md（詳見 AGENTS.md）

## 專案概述

- **埠：** 4377
- **角色：** Telegram Bot + 跨機記憶/知識橋接
- **功能：** 記憶儲存/召回、知識工具、對等同步、自動學習

## 目錄結構

```
telegram-memory-bridge/
├── src/
│   ├── index.ts                 # 應用入口
│   ├── bot.ts                   # Telegram Bot 核心
│   ├── api.ts                   # API 端點
│   ├── store.ts                 # 記憶儲存
│   ├── knowledge-tools.ts       # 知識工具
│   ├── tools.ts                 # 工具註冊
│   ├── types.ts                 # 型別定義
│   ├── types/
│   │   └── push.ts              # 推播型別
│   ├── device-config.ts         # 裝置配置
│   ├── lock.ts                  # 分散式鎖（Semaphore）
│   ├── encryption.ts            # 加密
│   ├── conversation-store.ts    # 對話儲存
│   ├── governor.ts              # 動態調速
│   ├── organizer.ts             # 記憶組織
│   ├── watcher.ts               # 檔案監控
│   ├── watch-and-push.ts        # 監控推播
│   ├── peer-puller.ts           # 對等拉取
│   ├── push-client.ts           # 推播客戶端
│   ├── processor.ts             # 訊息處理
│   ├── indexer.ts               # 索引器
│   ├── detect.ts                # 異常偵測
│   ├── auto-learning.ts         # 自動學習
│   └── websearch.ts             # 網路搜尋
```

## 關鍵功能

| 功能     | 檔案                 | 說明                  |
| -------- | -------------------- | --------------------- |
| Bot 核心 | `bot.ts`             | Telegram Bot 事件處理 |
| 記憶儲存 | `store.ts`           | 記憶 CRUD 操作        |
| 知識工具 | `knowledge-tools.ts` | 知識庫查詢/寫入工具   |
| 分散式鎖 | `lock.ts`            | Semaphore 併發控制    |
| 對等同步 | `peer-puller.ts`     | 跨機記憶同步          |
| 自動學習 | `auto-learning.ts`   | 從對話中自動學習      |
| 調速     | `governor.ts`        | 動態請求節奏控制      |
| 網路搜尋 | `websearch.ts`       | 整合 web 搜尋         |

## 相關章節

| 章節 | 內容                     | 位置                                 |
| ---- | ------------------------ | ------------------------------------ |
| §1-5 | 雙機架構、Semaphore、API | `qwen2api-dev/ARCHITECTURE.md`       |
| §8b  | 穩定性修復紀錄           | `qwen2api-dev/ARCHITECTURE.md`       |
| §11  | 插件規範                 | `qwen2api-dev/ARCHITECTURE.md`       |
| §24  | 完整路徑樹               | `qwen2api-dev/ARCHITECTURE.md §24.3` |

## 變更紀錄

| 日期       | 變更內容                                                                       | 檔案                       | 原因                                 |
| ---------- | ------------------------------------------------------------------------------ | -------------------------- | ------------------------------------ |
| 2026-06-12 | 新增目錄路徑樹 + 功能對照表                                                    | —                          | 初始架構文件                         |
| 2026-07-06 | 記憶儲存邏輯改善：cls===null+text≥80 仍儲存；store=false+text≥300 低重要性儲存 | bot.ts                     | 分類失敗/不儲存時內容完全丟棄        |
| 2026-07-06 | 新增教訓(lesson) push 支援：push-client/watch-and-push/api/index/store 皆補齊  | 5 檔案（詳見 lesson 教訓） | peer-puller 已有拉取但 push 端無對應 |

> 最後更新：2026-07-06（lesson push 支援）
> 如有架構變更需要，請先諮詢使用者確認。
