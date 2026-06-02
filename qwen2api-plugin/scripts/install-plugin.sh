#!/usr/bin/env bash
# ═══════════════════════════════════════════
# 一鍵安裝插件到 ~/.opencode/plugins/
# 使用方式:
#   bash scripts/install-plugin.sh
#   或
#   bun run setup
# ═══════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$HOME/.opencode/plugins"
PLUGIN_SRC="$DIR/src"

echo "🔌 安裝 OpenCode 插件..."

# 確保目標目錄存在
mkdir -p "$PLUGIN_DIR"

# 安裝 self-learning-plugin
if [ -f "$PLUGIN_SRC/self-learning-plugin.js" ]; then
  ln -sf "$PLUGIN_SRC/self-learning-plugin.js" "$PLUGIN_DIR/self-learning-plugin.js"
  echo "  ✅ self-learning-plugin.js"
else
  echo "  ⚠️ 找不到 self-learning-plugin.js"
fi

# 安裝主插件（選擇性）
read -p "  也要安裝主 qwen2api-plugin？(y/N): " yn
if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
  ln -sf "$PLUGIN_SRC/index.js" "$PLUGIN_DIR/qwen2api-plugin.js"
  echo "  ✅ qwen2api-plugin.js"
fi

echo ""
echo "🎉 安裝完成！重新啟動 OpenCode 即可使用。"
echo "   插件位置: $PLUGIN_DIR"
echo ""
ls -la "$PLUGIN_DIR"
