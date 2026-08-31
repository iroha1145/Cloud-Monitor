#!/usr/bin/env bash
# 启动 cloud-hub（FastAPI 网关 + 用量面板）。依赖 tm-core 已在 :17321 监听。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

set -a
[ -f hub/.env ] && . hub/.env
set +a

export TM_CORE_URL="${TM_CORE_URL:-http://127.0.0.1:17321}"
export DATABASE_PATH="${DATABASE_PATH:-$REPO_ROOT/data/cloud-monitor.sqlite3}"
export FRONTEND_DIR="${FRONTEND_DIR:-$REPO_ROOT/hub/frontend}"
export PYTHONPATH="${PYTHONPATH:-$REPO_ROOT/hub/backend}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-7878}"

# 等待 tm-core 就绪（最多 ~30s），避免启动初期 ready 探测抖动
for _ in $(seq 1 30); do
  if curl -fsS "$TM_CORE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

exec .venv/bin/python -m uvicorn hub.main:app \
  --host "$HOST" --port "$PORT" --workers 1 --loop uvloop
