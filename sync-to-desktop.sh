#!/usr/bin/env bash
# 同步修改檔案 筆電(Linux) → 桌機(Windows)
# 一次 tar pipe 連線，只問一次密碼
# 用法: bash sync-to-desktop.sh [--dry-run]
set -e

REMOTE="ReaMasTer@100.71.40.106"
SRC="/home/reamaster/opencode-manager"
DST="D:/opencode/opencode-manager"

DRY=""
[[ "$1" == "--dry-run" ]] && DRY="echo [DRY-RUN]"

FILES=(
  # ── 根目錄啟動/配置 ──
  projects/independent/qwen2api-dev/start.mjs
  projects/independent/qwen2api-dev/start.sh
  projects/independent/qwen2api-dev/start.bat
  projects/independent/qwen2api-dev/start.ps1
  projects/independent/qwen2api-dev/start.vbs
  projects/independent/qwen2api-dev/start-desktop.bat
  projects/independent/qwen2api-dev/start-desktop.ps1
  projects/independent/qwen2api-dev/start-qwen2api.bat
  projects/independent/qwen2api-dev/start-desktop.vbs
  projects/independent/qwen2api-dev/stop-desktop.bat
  projects/independent/qwen2api-dev/sync-to-desktop.sh
  projects/independent/qwen2api-dev/refresh-token.js
  projects/independent/qwen2api-dev/config.json
  projects/independent/qwen2api-dev/.gitignore
  projects/independent/qwen2api-dev/.ai-variant

  # ── config/ ──
  projects/independent/qwen2api-dev/config/paths.js

  # ── qwen2api 核心 ──
  projects/independent/qwen2api-dev/qwen2api/package.json
  projects/independent/qwen2api-dev/qwen2api/bun.lock
  projects/independent/qwen2api-dev/qwen2api/.env.example
  projects/independent/qwen2api-dev/qwen2api/src/

  # ── qwen2api-plugin ──
  projects/independent/qwen2api-dev/qwen2api-plugin/package.json
  projects/independent/qwen2api-dev/qwen2api-plugin/bun.lock
  projects/independent/qwen2api-dev/qwen2api-plugin/tsconfig.json
  projects/independent/qwen2api-dev/qwen2api-plugin/start.sh
  projects/independent/qwen2api-dev/qwen2api-plugin/src/
  projects/independent/qwen2api-dev/qwen2api-plugin/dist/

  # ── telegram-memory-bridge ──
  projects/independent/qwen2api-dev/telegram-memory-bridge/package.json
  projects/independent/qwen2api-dev/telegram-memory-bridge/bun.lock
  projects/independent/qwen2api-dev/telegram-memory-bridge/tsconfig.json
  projects/independent/qwen2api-dev/telegram-memory-bridge/config.json
  projects/independent/qwen2api-dev/telegram-memory-bridge/.env.example
  projects/independent/qwen2api-dev/telegram-memory-bridge/start.bat
  projects/independent/qwen2api-dev/telegram-memory-bridge/start.ps1
  projects/independent/qwen2api-dev/telegram-memory-bridge/start.sh
  projects/independent/qwen2api-dev/telegram-memory-bridge/api-server.sh
  projects/independent/qwen2api-dev/telegram-memory-bridge/src/

  # ── knowledge-wiki-plugin ──
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/package.json
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/src/
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/dist/
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/config.json
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/openclaw.plugin.json
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/SKILL.md
  projects/independent/qwen2api-dev/knowledge-wiki-plugin/setup.sh

  # ── 文件 ──
  projects/independent/qwen2api-dev/AGENTS.md
  projects/independent/qwen2api-dev/ARCHITECTURE.md
  projects/independent/qwen2api-dev/qwen2api/ARCHITECTURE.md
  projects/independent/qwen2api-dev/qwen2api-plugin/ARCHITECTURE.md
  projects/independent/qwen2api-dev/telegram-memory-bridge/ARCHITECTURE.md
  projects/independent/qwen2api-dev/README.md
  projects/independent/qwen2api-dev/MILESTONES.md
  projects/independent/qwen2api-dev/ROADMAP.md
  projects/independent/qwen2api-dev/TROUBLESHOOT.md
  projects/independent/qwen2api-dev/VERSION_SOP.md
  projects/independent/qwen2api-dev/預設指令.md

  # ── 終端機入口（Windows Terminal binary 需手動複製） ──

  # ── 系統規範更新 ──
  projects/system/AGENTS.md
  projects/system/packages/opencode/AGENTS.md
)

echo "╔══════════════════════════════════════════╗"
echo "║  同步 → 桌機 (tar-over-SSH)             ║"
echo "╚══════════════════════════════════════════╝"
echo "來源: ${SRC}"
echo "目標: ${DST} (${REMOTE})"
echo "檔案數: ${#FILES[@]}"
echo ""

if [[ -n "$DRY" ]]; then
  for f in "${FILES[@]}"; do echo "  ${f}"; done
  echo ""
  echo "[DRY-RUN] ${#FILES[@]} 個項目 (模擬)"
  exit 0
fi

# tar pipe: 本地壓縮(-C 切到 SRC) → pipe SSH → PowerShell 解壓
tar -C "${SRC}" -czf - "${FILES[@]}" \
  | ssh "${REMOTE}" "powershell -Command \"mkdir -Force '${DST}'; tar -xzf - -C '${DST}'\""

echo ""
echo "✅ 同步完成 (${#FILES[@]} 個項目)"
echo ""
echo "──────────────────────────────────────"
echo "下一步（在桌機上執行）："
echo "  1. 複製 .env 檔案（不在同步清單中）"
echo "  2. 在各子目錄執行 bun install"
echo "  3. 雙擊 start-desktop.bat 啟動"
echo "──────────────────────────────────────"
