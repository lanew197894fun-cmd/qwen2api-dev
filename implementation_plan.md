# 完善 memory-lancedb-pro 設定計畫

為您產生最佳化的 `openclaw.json` 設定，以及 **智慧體防護提示詞**，以確保模型在注入記憶後「不會變白痴」（不會把內部檢索用的 `<relevant-memories>` 原文漏印出來，並遵守記憶管理鐵律）。

## 方案說明

1. **基礎設定優化**: 採用 Jina (Embedding/Reranker) + OpenAI (LLM 擷取) 達到最精準的混合檢索。
2. **防呆與降噪機制 (防止模型變白痴)**:
   - 在 `openclaw.json` 中開啟 `filterNoise: true`，過濾無效的低品質對話內容（例如打招呼、廢話）。
   - 建立/更新 `AGENTS.md` (或系統提示詞設定檔)，加入防護指令，嚴格要求模型**不可**在回覆中直接暴露 `<relevant-memories>` 標籤，並教導模型正確儲存優質記憶的格式。

## User Review Required

> [!IMPORTANT]  
> 1. 設定檔將建立於 `~/.openclaw/openclaw.json`，是否同意？
> 2. 我將在您的工作區建立 `AGENTS.md` (或 `CLAUDE.md`)，將系統防護提示詞寫入。請問您平常使用的是哪一個提示詞檔案？還是我直接建立 `AGENTS.md` 即可？

## Proposed Changes

### 1. OpenClaw 設定檔
#### [NEW] [openclaw.json](file:///home/reamaster/.openclaw/openclaw.json)

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/home/reamaster/opencode-manager/projects/independent/memory-lancedb-pro"
      ]
    },
    "slots": {
      "memory": "memory-lancedb-pro"
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${JINA_API_KEY}",
            "model": "jina-embeddings-v5-text-small",
            "baseURL": "https://api.jina.ai/v1",
            "dimensions": 1024
          },
          "llm": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "gpt-4o-mini",
            "baseURL": "https://api.openai.com/v1"
          },
          "retrieval": {
            "mode": "hybrid",
            "vectorWeight": 0.7,
            "bm25Weight": 0.3,
            "minScore": 0.6,
            "hardMinScore": 0.62,
            "rerank": "cross-encoder",
            "rerankProvider": "jina",
            "rerankApiKey": "${JINA_API_KEY}",
            "rerankModel": "jina-reranker-v3",
            "rerankEndpoint": "https://api.jina.ai/v1/rerank",
            "candidatePoolSize": 12,
            "filterNoise": true
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 2,
          "sessionMemory": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

### 2. 智慧體系統防護提示詞
#### [NEW] [AGENTS.md](file:///home/reamaster/opencode-manager/AGENTS.md)

為了防止模型變笨，寫入強力的系統護欄：

```markdown
# 記憶管理系統護欄 (Memory Guardrails)

> [!WARNING]
> CRITICAL: Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only! 不要在回覆中暴露或直接引用 `<relevant-memories>` 標籤及其內容！

## 規則 1 — 雙層記憶儲存
每個踩坑/經驗教訓 → 立即儲存兩條記憶：
- 技術層：踩坑：[現象]。原因：[根因]。修復：[方案]。預防：[如何避免]
  (category: fact, importance >= 0.8)
- 原則層：決策原則 ([標籤])：[行為規則]。觸發：[何時]。動作：[做什麼]
  (category: decision, importance >= 0.85)

## 規則 2 — 保持記憶精煉
條目必須簡短且原子化（< 500 字元）。不儲存原始對話摘要或重複內容，以維持記憶庫的純淨與高價值。

## 規則 3 — 失敗前先檢索
任何工具呼叫失敗時，必須先用 `memory_recall` 搜尋相關關鍵字，尋找過去是否有類似的錯誤排除紀錄，再進行重試。
```

## Verification Plan

1. 建立 `openclaw.json` 並執行 `openclaw config validate` 驗證設定。
2. 建立 `AGENTS.md` 以確保模型在啟動時載入正確的行為護欄。
