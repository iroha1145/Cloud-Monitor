#!/usr/bin/env bash
# 在线备份：默认实例与磁盘上所有租户的 TM 状态和 SQLite。
# 两卷独立：先备 devices.json（官方原子写），再备 SQLite（.backup 一致性快照）。
# 用法: ./backup.sh /path/to/backup-dir   （compose 服务运行中即可执行）
set -eu
umask 077

BACKUP_DIR=${1:?"用法: backup.sh <备份目录>"}
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/cloud-monitor-backup-$TS"
mkdir -p "$BACKUP_DIR"
mkdir "$OUT"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HUB_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
HELPER="$SCRIPT_DIR/backup_data.py"
TM_COPY="$OUT/.tm-state"
TENANT_LIST="$OUT/.hub-tenants"
trap 'rm -rf -- "$TM_COPY"; rm -f -- "$TENANT_LIST"' EXIT

container_running() {
  service="$1"
  cid=$(cm_compose "$HUB_DIR" ps -q "$service" 2>/dev/null || true)
  [ -n "$cid" ] || return 1
  docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null | grep -qx true
}

echo "[1/3] 备份默认实例和所有租户的 tm-core 状态..."
if ! container_running tm-core; then
  echo "tm-core 未运行，无法备份 devices.json" >&2
  exit 1
fi
# 官方按原子替换写 JSON；复制运行中卷内的文件，包括已移出配置的租户。
docker cp "$cid:/data/." "$TM_COPY"
python3 "$HELPER" copy-tm "$TM_COPY" "$OUT"

echo "[2/3] 备份 SQLite（Python sqlite3.backup，流式落到宿主机）..."
if ! container_running cloud-hub; then
  echo "cloud-hub 未运行，无法备份 SQLite" >&2
  exit 1
fi
cm_compose "$HUB_DIR" exec -T cloud-hub python3 - snapshot /data/cloud-monitor.sqlite3 \
  < "$HELPER" > "$OUT/cloud-monitor.sqlite3"
[ -s "$OUT/cloud-monitor.sqlite3" ] || { echo "SQLite 备份是空文件" >&2; exit 1; }
cm_compose "$HUB_DIR" exec -T cloud-hub python3 - list-hub /data < "$HELPER" > "$TENANT_LIST"
while IFS= read -r tenant; do
  mkdir -p "$OUT/tenants/$tenant"
  cm_compose "$HUB_DIR" exec -T cloud-hub python3 - snapshot \
    "/data/tenants/$tenant/hub.sqlite3" < "$HELPER" > "$OUT/tenants/$tenant/hub.sqlite3"
done < "$TENANT_LIST"
rm -rf -- "$TM_COPY"
rm -f -- "$TENANT_LIST"
python3 "$HELPER" validate "$OUT"

echo "[3/3] 备份 manifest（两卷时间点）..."
SQLITE_WARN=""
SQLITE_BUCKET=$(python3 - "$OUT/cloud-monitor.sqlite3" <<'PY'
import sqlite3, sys
from pathlib import Path
try:
    con = sqlite3.connect(Path(sys.argv[1]).absolute().as_uri() + "?mode=ro&immutable=1", uri=True)
    row = con.execute("SELECT MAX(bucket_start) FROM tm_snapshot_buckets").fetchone()
    print(row[0] if row and row[0] else "")
    con.close()
except Exception as exc:
    print("", end="")
    sys.stderr.write(f"WARN: sqlite unreadable: {exc}\n")
    sys.exit(2)
PY
) || SQLITE_WARN="WARN: sqlite unreadable"
{
  echo "backup_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tm-core devices.json saved_at:"
  grep -o '"savedAt": *"[^"]*"' "$OUT/devices.json" | head -1 || true
  echo "sqlite latest bucket:"
  echo "$SQLITE_BUCKET"
  if [ -n "$SQLITE_WARN" ]; then
    echo "$SQLITE_WARN"
  fi
  if [ -d "$OUT/tenants" ]; then
    echo "tenant files (including tenants no longer configured):"
    find "$OUT/tenants" -type f -printf '%P\n' | sort
  fi
} > "$OUT/BACKUP-MANIFEST.txt"

echo "备份完成: $OUT"
ls -la "$OUT"
