#!/usr/bin/env bash
# token-usage.sh — 查詢「發一次對話給千問代理」實際花費多少 tokens
#
# 權威來源 = qwen2api (3000) 的 log；chat-proxy (3456) 與 opencode DB 都只是轉發/記錄，不準。
#
# 用法:
#   ./token-usage.sh            # 顯示最近 10 筆統計
#   ./token-usage.sh 20         # 顯示最近 20 筆
#   ./token-usage.sh --summary  # 顯示今日累計 (input/output/total) 與平均

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # qwen2api/
LOG_GLOB="$ROOT/../logs/run-*/qwen2api.log"
PATTERN="使用tiktoken計算|使用上游真實Token"

command -v grep >/dev/null || { echo "缺少 grep"; exit 1; }

if [ "${1:-}" = "--summary" ]; then
  echo "=== 最近統計（輸入/輸出/總計）==="
  grep -ahE "$PATTERN" $LOG_GLOB 2>/dev/null | tail -200 | \
    sed 's/\x1b\[[0-9;]*m//g' | \
    python3 -c "
import sys, re
rows = []
for ln in sys.stdin:
    m = re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*?Prompt: (\d+), Completion: (\d+), Total: (\d+)', ln)
    if m:
        rows.append((m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))))
if not rows:
    print('（無資料）')
    sys.exit(0)
ti = sum(r[1] for r in rows); to = sum(r[2] for r in rows); tt = sum(r[3] for r in rows)
print(f'筆數      : {len(rows)}')
print(f'Prompt    : {ti:,}')
print(f'Completion: {to:,}')
print(f'Total     : {tt:,}')
print(f'平均/筆   : prompt {ti//len(rows):,} / completion {to//len(rows):,} / total {tt//len(rows):,}')
print()
print('最近 5 筆:')
for r in rows[-5:]:
    print(f'  {r[0]}  prompt={r[1]:>7,}  completion={r[2]:>7,}  total={r[3]:>7,}')
"
  exit 0
fi

N="${1:-10}"
echo "=== 最近 $N 筆 token 統計（qwen2api 權威來源）==="
grep -ahE "$PATTERN" $LOG_GLOB 2>/dev/null | tail -"$N" | sed 's/\x1b\[[0-9;]*m//g'
echo
echo "提示：prompt 含 proxy 注入的工具清單/認知提示/persona/對話摘要，故遠大於原始提問。"
