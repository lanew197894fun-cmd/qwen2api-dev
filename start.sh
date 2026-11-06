#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"
exec bun start.mjs "$@"
