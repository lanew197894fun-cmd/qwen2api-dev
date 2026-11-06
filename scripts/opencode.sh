#!/usr/bin/env bash
# 免額（chat.qwen.ai）專用 opencode 啟動器。
# 免額 provider／agent／model 一律由本專案的 opencode.free-tier.json 提供，
# 不再寫入 repo 根或 projects/.opencode 的設定，避免多處重複造成混亂。
set -e
CFG="$(cd "$(dirname "$0")/.." && pwd)/opencode.free-tier.json"
[ -f "$CFG" ] || { echo "缺少設定檔: $CFG" >&2; exit 1; }
export OPENCODE_CONFIG="$CFG"
exec opencode "$@"
