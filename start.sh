#!/usr/bin/env bash
# Unified cross-platform launcher wrapper
# Delegates to the Bun-based start.js
set -e
cd "$(dirname "$0")"
bun start.js "$@"
