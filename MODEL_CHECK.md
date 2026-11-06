# Qwen3.7-Max-Preview 模型檢查指南

## 1. 驗證上游是否有該模型

在終端機執行以下指令，確認 qwen2api 是否載入該模型：

curl -s http://127.0.0.1:3000/api/v2/configs/ | jq '.data.models[].id' 2>/dev/null | grep -i "qwen3\|max"

若無輸出，表示上游 API 未提供此模型。

## 2. 檢查 chat-proxy 路由設定

檔案位置：chat-proxy/src/routes/chat.ts

搜尋 modelMap 或 routeConfig，確認是否有過濾規則阻擋新模型。

## 3. 手動添加模型 (若上游存在)

若步驟 1 有回傳模型 ID，但 chat-proxy 未顯示，需編輯路由設定：

1. 開啟 chat-proxy/src/config/models.json (或對應設定檔)
2. 加入新模型映射：
{
  "id": "qwen3.7-max-preview",
  "name": "Qwen3.7 Max Preview",
  "enabled": true
}

3. 重啟 chat-proxy：
pkill -f "bun run.*chat-proxy"
cd chat-proxy && bun dev &

## 4. 常見問題

- 模型名稱大小寫敏感，請確認精確 ID
- 部分預覽模型需額外權限啟用
- 檢查 ~/.opencode/config.json 是否有模型黑白名單設定
