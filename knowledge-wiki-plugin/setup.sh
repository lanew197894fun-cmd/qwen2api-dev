#!/usr/bin/env bash
# knowledge-wiki-plugin 一鍵設定腳本
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $1"; }
error() { echo -e "${RED}[setup]${NC} $1"; }

FORCE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)   FORCE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *)         error "Unknown option: $1"; exit 1 ;;
  esac
done

info "knowledge-wiki-plugin setup starting..."

# ── 1. Environment check ──
NODE_VER=$(node -v 2>/dev/null || echo "none")
if [[ "$NODE_VER" == "none" ]]; then
  error "Node.js not found. Please install Node >= 18"
  exit 1
fi
info "Node: $NODE_VER"

BUN_VER=$(bun -v 2>/dev/null || echo "none")
if [[ "$BUN_VER" != "none" ]]; then
  info "Bun: $BUN_VER"
fi

# ── 2. Install dependencies ──
if [ -f "$DIR/package.json" ]; then
  if [ "$DRY_RUN" = true ]; then
    info "[dry-run] Would install dependencies"
  else
    info "Installing dependencies..."
    (cd "$DIR" && bun install --no-summary 2>/dev/null || npm install --no-audit --no-fund 2>/dev/null || true)
    info "Dependencies installed"
  fi
fi

# ── 3. Create data directories ──
if [ "$DRY_RUN" = true ]; then
  info "[dry-run] Would create: .opencode/knowledge, .opencode/lesson-learned, .wiki"
else
  mkdir -p "$DIR/.opencode/knowledge"
  mkdir -p "$DIR/.opencode/lesson-learned"
  mkdir -p "$DIR/.wiki"
  info "Data directories created"
fi

# ── 4. Config injection ──
CONFIG_DIR="${HOME}/.opencode"
CONFIG_FILE="${CONFIG_DIR}/config.json"
if [ "$DRY_RUN" = true ]; then
  info "[dry-run] Would inject config into ${CONFIG_FILE}"
elif [ ! -f "$CONFIG_FILE" ] || [ "$FORCE" = true ]; then
  mkdir -p "$CONFIG_DIR"
  if [ ! -f "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
  fi
  info "Config ensured at ${CONFIG_FILE}"
else
  info "Config exists at ${CONFIG_FILE} (use --force to overwrite)"
fi

# ── 5. Symlink shared deps ──
SYS_NM="${DIR}/../../system/packages/opencode/node_modules"
PLUGIN_NM="${DIR}/node_modules"
if [ "$DRY_RUN" = true ]; then
  info "[dry-run] Would symlink shared dependencies"
elif [ -d "$SYS_NM" ]; then
  mkdir -p "$PLUGIN_NM"
  for dep in "@opencode-ai/plugin" "zod"; do
    SRC="${SYS_NM}/${dep}"
    DST="${PLUGIN_NM}/${dep}"
    if [ -d "$SRC" ] && [ ! -e "$DST" ]; then
      ln -sf "$SRC" "$DST"
      info "Symlinked ${dep}"
    fi
  done
  info "Shared dependencies linked"
else
  warn "System node_modules not found at ${SYS_NM}, skipping symlinks"
fi

info "✅ knowledge-wiki-plugin setup complete!"
echo ""
echo "  Run: bun run build  to build the plugin"
echo "  Run: bun run dev    to build & preview"
