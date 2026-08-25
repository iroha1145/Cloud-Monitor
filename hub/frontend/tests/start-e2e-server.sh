#!/usr/bin/env bash
# §13 e2e scratch 夹具：复制后端基线到临时目录，覆盖 hub/frontend 页面文件。
# 后端源码零改动（复制件 diff 可证）；真实 FastAPI/uvicorn 起服务。
# 基线 = cm-current @ origin/main（provider-status / history/daily 为真实端点；
# 未配置 TOKEN_MONITOR_SECRET → Token Monitor 未启用，按契约返回 404）。
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="${CM_BASELINE:-$(cd "$FRONTEND_DIR/../.." && pwd)}"
E2E_ROOT="${CM_E2E_ROOT:-$HOME/cm-e2e}"
PORT="${CM_E2E_PORT:-18787}"

# 基线变更（或首次）时重建 scratch 副本，避免陈旧后端
STAMP="$E2E_ROOT/.baseline"
if [ ! -d "$E2E_ROOT/hub/backend" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$BASELINE" ]; then
  rm -rf "$E2E_ROOT"
  cp -r "$BASELINE" "$E2E_ROOT"
  echo "$BASELINE" > "$STAMP"
fi
# 覆盖前端文件（测试夹具，非改后端源码目录）
cp "$FRONTEND_DIR/index.html" "$FRONTEND_DIR/demo.html" "$FRONTEND_DIR/tm.css" \
   "$FRONTEND_DIR/tm.js" "$FRONTEND_DIR/mock.js" "$FRONTEND_DIR/icons.svg" \
   "$FRONTEND_DIR/theme-boot.js" \
   "$E2E_ROOT/hub/frontend/"
# 基线路径不变时 scratch 里的 backend 会陈旧，每次用当前仓库覆盖
cp -R "$FRONTEND_DIR/../backend/." "$E2E_ROOT/hub/backend/"

cd "$E2E_ROOT/hub/backend"
export API_KEY="${CM_E2E_API_KEY:-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855}"
export ACCESS_TOKEN="${CM_E2E_TOKEN:-test-token}"
export DATABASE_PATH="$E2E_ROOT/data/e2e.sqlite3"
export TM_BACKGROUND_ENABLED=false
export CM_DEMO=false
export CM_SERVE_DEMO=true
exec python3 -m uvicorn hub.main:app --host 127.0.0.1 --port "$PORT"
