#!/usr/bin/env bash
# start-tmux.sh - qwen2api-dev tmux launcher
# 取代 start.sh (ptyxis/flatpak)，避免滯留訊息
# Usage: ./start-tmux.sh
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
export DEVICE_ROLE=laptop

TMUX_SESSION="qwen2api"
API_DIR="$PWD/qwen2api"
PLUGIN_DIR="$PWD/qwen2api-plugin"

kill_orphans() {
  for port in 3000 3456; do
    local pids
    pids=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$pids" ] && continue
    for pid in $pids; do
      # 只殺屬於本專案的行程：工作目錄必須為本專案子目錄
      local cwd
      cwd=$(readlink /proc/$pid/cwd 2>/dev/null || true)
      # 精確匹配：cwd 必須以本專案目錄開頭
      case "$cwd" in
        "$API_DIR"*) kill "$pid" 2>/dev/null || true ;;
        "$PLUGIN_DIR"*) kill "$pid" 2>/dev/null || true ;;
        *) : ;; # 非本專案行程，跳過
      esac
    done
  done
}

# 清理殘留 Chrome 孤兒
for pid in $(ps aux | grep "chrome.*chrome-qwen-profile" | grep -v grep | awk '{print $2}' 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null || true
done

# 清理舊 tmux session
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
sleep 1
kill_orphans
sleep 1

# 建立新 session（detached）
tmux new-session -d -s "$TMUX_SESSION" -n qwen2api

# window 1: qwen2api (port 3000)
tmux send-keys -t "$TMUX_SESSION:0" \
  "cd $API_DIR && bun src/start.js" Enter

# window 2: chat-proxy (port 3456)
tmux new-window -t "$TMUX_SESSION" -n chat-proxy
tmux send-keys -t "$TMUX_SESSION:1" \
  "cd $PLUGIN_DIR && PROXY_PORT=3457 bun src/start-proxy.js" Enter

echo "────────────────────────────────────"
echo "  千問模型已啟動 (tmux session)"
echo ""
echo "  查看日誌: tmux attach -t $TMUX_SESSION"
echo "  視窗切換: Ctrl+B 1 (qwen2api)"
echo "            Ctrl+B 2 (chat-proxy)"
echo "  分離:     Ctrl+B D"
echo "  停止:     tmux kill-session -t $TMUX_SESSION"
echo "────────────────────────────────────"
