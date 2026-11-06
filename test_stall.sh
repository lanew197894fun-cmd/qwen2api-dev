#!/usr/bin/env bash
# 停頓測試腳本 — 精確記錄每個階段的耗時
# 🐛 FIX: 改經 chat-proxy (port 3456)，獲得模型路由與停滯矯正保護
API="http://127.0.0.1:3456"
KEY="sk-qwen2api-test-2026"
MODEL="qwen3.6-27b"

echo "=== 階段 1: 模型列表 ==="
time curl -s "$API/v1/models" -H "Authorization: Bearer $KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  {len(d.get(\"data\",[]))} 模型')"

echo ""
echo "=== 階段 2: 純文字（記錄 T1=建聯 T2=首token T3=完成）==="
curl -s -w "\n---\nHTTP_CODE: %{http_code}\nTIME_TOTAL: %{time_total}s\nTIME_STARTTRANSFER: %{time_starttransfer}s\nTIME_CONNECT: %{time_connect}s\n" \
  --max-time 120 \
  -X POST "$API/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"一句話回應：你好嗎？\"}]}"

echo ""
echo "=== 階段 3: 含 tools（測試 tool 管線）==="
time curl -s --max-time 120 \
  -X POST "$API/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\":\"$MODEL\",
    \"messages\":[{\"role\":\"user\",\"content\":\"讀取 /tmp/test.txt\"}],
    \"tools\":[{\"function\":{\"name\":\"read_file\",\"description\":\"Read a file\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}}}]
  }"

echo ""
echo "=== 階段 4: 串流（看 chunk 間隔）==="
time curl -N -s --max-time 120 \
  -X POST "$API/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"一句話回應：hi\"}],\"stream\":true}"
