# knowledge-wiki-plugin 技能說明

## 功能概述

整合知識庫、經驗教訓與維基系統的 OpenCode 插件。支援自動分類、重複檢測、批量去重與 Provider 可插拔存儲。

## 可用工具

| 工具                    | 功能                      |
| ----------------------- | ------------------------- |
| `knowledge/save`        | 儲存知識（自動分類+去重） |
| `knowledge/index`       | 瀏覽知識索引              |
| `knowledge/read`        | 閱讀知識條目              |
| `knowledge/deduplicate` | 批量清除重複知識          |
| `lesson/save`           | 記錄經驗教訓              |
| `lesson/list`           | 列出所有教訓              |
| `wiki/save`             | 儲存維基條目              |
| `wiki/list`             | 列出維基條目              |
| `wiki/read`             | 閱讀維基條目              |

## 數據位置

- 知識庫：`.opencode/knowledge/`
- 經驗教訓：`.opencode/lesson-learned/`
- 維基：`.wiki/`

## Provider 模式

支援可插拔存儲後端，預設為 FileProvider（Markdown 檔案系統）。

### 切換 Provider

```json
{
  "knowledge-wiki-plugin": {
    "provider": "file"
  }
}
```

## 分類系統

自動分類基於關鍵詞匹配，支援 9 大類別：

| 分類        | 關鍵詞                     |
| ----------- | -------------------------- |
| 01-技術主題 | 技術、架構、設計、最佳實踐 |
| 02-專案管理 | 專案、進度、規格、需求     |
| 03-問題修復 | 修復、bug、error、除錯     |
| 04-工具配置 | 安裝、配置、tool、CLI      |
| 05-整合紀錄 | 整合、deploy、sync、部署   |
| 06-學習筆記 | 學習、研究、筆記、tutorial |
| 07-功能更新 | 新增、更新、feature、版本  |
| 08-討論決策 | 決策、討論、decision、ADR  |
| 09-記憶系統 | 記憶、memory、preference   |

## 嚴重等級（經驗教訓）

| 等級        | 說明                 |
| ----------- | -------------------- |
| P0-嚴重翻車 | 崩潰、資料損失、破壞 |
| P1-功能錯誤 | 編譯失敗、邏輯錯誤   |
| P2-效能問題 | 效能低落、記憶體洩漏 |
| P3-體驗不佳 | 缺少訊息、錯位       |
| P4-最佳實踐 | 優化建議、改進       |

## 重複檢測

- 基於 Jaccard 相似度（詞集交集/聯集）
- 預設閾值 0.85（可配置）
- 超時保護：5 秒後跳過剩餘檔案
- 最大比對檔案數：50
