#!/usr/bin/env bash
# 启动 tm-core（vendored 官方 token-monitor hub，零 npm 依赖）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/hub/tm-core"

set -a
[ -f "$REPO_ROOT/hub/.env" ] && . "$REPO_ROOT/hub/.env"
set +a

export TOKEN_MONITOR_PORT="${TOKEN_MONITOR_PORT:-17321}"
export TOKEN_MONITOR_HOST="${TOKEN_MONITOR_HOST:-127.0.0.1}"
export TOKEN_MONITOR_DATA_FILE="${TOKEN_MONITOR_DATA_FILE:-$REPO_ROOT/data/devices.json}"

exec node run.js
