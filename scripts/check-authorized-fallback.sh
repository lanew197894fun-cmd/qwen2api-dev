#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

log() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
err() { printf '❌ %s\n' "$*" >&2; }

log "qwen2api 已授權後備設定檢查"

if [[ ! -f "$ENV_FILE" ]]; then
  err "找不到 .env：$ENV_FILE"
  exit 1
fi

env_value() {
  local key="$1"
  awk -v k="$key" '
    /^[[:space:]]*#/ {next}
    $0 ~ "^[[:space:]]*" k "=" {
      v=$0
      sub("^[[:space:]]*" k "=", "", v)
      sub(/^[[:space:]]*/, "", v)
      sub(/[[:space:]]*$/, "", v)
      if (v ~ /^["\x27]/ && v ~ /["\x27]$/) v=substr(v,2,length(v)-2)
      print v; exit
    }' "$ENV_FILE" || true
}

names="$(env_value PROVIDER_NAMES || true)"
normalized="$(printf '%s' "$names" | tr -d '[]"'"'"' ')"

if [[ -z "$normalized" ]]; then
  warn "PROVIDER_NAMES 未設定；目前只透過 qwen2api（Web 免額），CLI 驗證未通過時沒有後備。"
  warn "已授權的後備範例："
  warn "  PROVIDER_NAMES=qwen2api,groq"
  warn "  PROVIDER_GROQ_URL=https://api.groq.com/openai/v1"
  warn "  PROVIDER_GROQ_KEY=<你的已授權金鑰>"
  exit 2
fi

log "PROVIDER_NAMES：$normalized"

fail=0
curl_ok=0
while IFS= read -r raw; do
  n="$(printf '%s' "$raw" | tr -d '[:space:]')"
  [[ -z "$n" ]] && continue
  key="$(printf '%s' "$n" | tr '[:lower:]-' '[:upper:]_')"
  url="$(env_value "PROVIDER_${key}_URL")"
  api_key="$(env_value "PROVIDER_${key}_KEY")"
  if [[ "$n" == "qwen2api" || "$n" == "qwen2api-direct" ]]; then
    url="${url:-http://127.0.0.1:3000}"
    api_key="${api_key:-(使用本機 API_KEY)}"
  fi
  if [[ -z "$url" ]]; then
    err "$n：缺少 PROVIDER_${key}_URL"
    fail=1
    continue
  fi
  if [[ -z "$api_key" ]]; then
    err "$n：缺少 PROVIDER_${key}_KEY（授權金鑰）"
    fail=1
    continue
  fi
  probe="${url%/}/models"
  [[ "$probe" != */models ]] && probe="${url%/}/v1/models"
  http="$(curl -s -m 8 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $api_key" "$probe" || printf '000')"
  printf '  %-12s URL 可連線（HTTP %s）\n' "$n" "$http"
  [[ "$http" != "000" ]] && curl_ok=$((curl_ok+1))
done < <(printf '%s' "$normalized" | tr ',' '\n')

if [[ "$fail" == 1 ]]; then
  err "後備設定不完整；CLI 驗證失敗時不會有可用後備。"
  exit 3
fi

log "設定檢查完成：$curl_ok 個端點可連線。"
if [[ "$curl_ok" -eq 0 ]]; then
  warn "設定已存在但端點無法連線，請確認網路與金鑰權限。"
  exit 4
fi
log "CLI 驗證失敗時：依 PROVIDER_NAMES 順序使用已授權後備；未設定則顯示「額度耗盡／需授權」。"
