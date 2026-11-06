# qwen2api-dev

> 千問模型本地 API 代理系統 — 主要開發線

## 概述

Qwen2API 是千問模型的本地 API 代理系統，提供 OpenAI 相容的聊天完成端點，支援工具呼叫（MCP）、模型路由、自我學習、自主進化等進階功能。

## 跨裝置支援

本專案支援 **Linux 與 Windows**（亦相容 macOS），依 `process.platform` 自動切換路徑與啟動方式：

| 平台    | 啟動方式                              | 專案根目錄                     | 對應裝置                  |
| ------- | ------------------------------------- | ------------------------------ | ------------------------- |
| Linux   | `bash start.sh` / `bun run dev`       | `~/opencode-manager`           | 筆電（開發機，AnduinOS）   |
| Windows | `start-desktop.bat` / `start.ps1`     | `D:\opencode\opencode-manager` | 桌機（主力機，Windows 11） |

- 跨裝置是指**本機路徑依平台自動切換**，不是遠端連線（唯一對外：Telegram Bot 綁 `0.0.0.0`，其餘綁 `127.0.0.1`）
- Windows 下 `start.sh` 等同 `start.ps1`，啟動器 `start.mjs` 內建平台分支與埠清理邏輯
- 詳細規範見 [AGENTS.md](AGENTS.md)（含裝置對照表與路徑切換規則）

## 子專案

| 子專案                   | 埠   | 功能                                                       |
| ------------------------ | ---- | ---------------------------------------------------------- |
| `qwen2api`               | 3000 | 核心服務：將 chat.qwen.ai 轉換為 OpenAI 相容 API           |
| `qwen2api-plugin`        | 3456 | opencode 插件 + chat-proxy：請求路由、tool_calls、自我學習 |
| `telegram-memory-bridge` | 4377 | Telegram Bot + 跨機記憶/知識橋接                           |
| `knowledge-wiki-plugin`  | —    | 知識庫/維基/教訓 OpenCode 插件                             |

## 快速開始

```bash
# 一鍵啟動全部服務
bash start.sh              # Linux
start-desktop.bat          # Windows（背景執行）
start-desktop.vbs          # Windows（靜默後台）

# 或使用 bun
bun run dev

# 單獨啟動特定服務
cd qwen2api && bun src/start.js                    # 僅 qwen2api
cd qwen2api-plugin && bun src/start-proxy.js       # 僅 proxy
cd telegram-memory-bridge && bun src/index.ts       # 僅 telegram
```

## 關鍵特性

- **統一色彩系統** (`src/color.js`)：TrueColor 支援、語義色、標籤色、自動環境偵測
- **錯誤高可見性**：`[系統錯誤]` 紅色加粗，極難被忽略
- **模型路由**：依任務複雜度自動切換 small/medium/large 模型
- **自我學習**：程式碼風格分析、回應風格學習、問題解決記錄
- **自主進化**：事件驅動分析、關鍵字權重自動調整、路由優化
- **雙機架構**：筆電（輕量節點）↔ 桌機（Master），Tailscale VPN 連線

## 文件

- [ARCHITECTURE.md](ARCHITECTURE.md) — 系統架構、啟動流程、通訊架構
- [AGENTS.md](AGENTS.md) — AI 行為規範、開發環境、不變邊界
- [TROUBLESHOOT.md](TROUBLESHOOT.md) — 滯留訊息修復手冊
- [VERSION_SOP.md](VERSION_SOP.md) — 版本追蹤 SOP
- [ROADMAP.md](ROADMAP.md) — 專案路線圖
- [MILESTONES.md](MILESTONES.md) — 里程碑

## 環境變數

| 變數                 | 預設 | 說明                                     |
| -------------------- | ---- | ---------------------------------------- |
| `QWEN2API_PORT`      | 3000 | qwen2api 端口                            |
| `PROXY_PORT`         | 3456 | Proxy 端口                               |
| `PROXY_LOG_LEVEL`    | warn | 日誌等級（silent/error/warn/info/debug） |
| `FORCE_COLOR`        | —    | 強制啟用色彩                             |
| `NO_COLOR`           | —    | 強制禁用色彩                             |
| `TAILSCALE_WATCH`    | off  | 筆電模式跳過 tailscale 輪詢              |
| `MASTER_IP`          | —    | 雙機主機 IP                              |
| `TELEGRAM_BOT_TOKEN` | —    | 有設定才啟動 telegram-bridge             |

## 開發環境

- **CPU**：i5-5200U（2C4T，老舊）
- **RAM**：8GB + 2GB swap
- **OS**：Ubuntu 24.04
- **輕量化**：`LIGHTWEIGHT=true`（Chrome `--single-process`，節省 60-70% 記憶體）

## 授權

MIT
