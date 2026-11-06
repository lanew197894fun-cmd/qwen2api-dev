# 檢查 Qwen3.7-Max-Preview 模型

## 1. 查看目前可用模型 (在終端機執行)

curl -s http://127.0.0.1:3456/v1/models | jq '.data[].id' | grep -i qwen

## 2. 若找不到，檢查原始 API

curl -s http://127.0.0.1:3000/api/v2/configs/ | jq '.data.models[].id' 2>/dev/null | grep -i "qwen3\|max"

## 3. 可能原因
- 模型未在上游 API 啟用
- 模型名稱不同（如 Qwen3-Max、Qwen-Max-Preview）
- chat-proxy 過濾規則阻擋

## 4. 手動添加模型 (若確認存在)
編輯 chat-proxy/src/routes/chat.ts，在 modelMap 中加入對應路由。
