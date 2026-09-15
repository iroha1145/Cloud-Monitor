#!/bin/sh
# 一致性备份：tm-core 的 devices.json + SQLite 的 cloud-monitor.sqlite3。
# 两卷独立：先备 devices.json（官方原子写），再备 SQLite（.backup 一致性快照）。
# 用法: ./backup.sh /path/to/backup-dir   （compose 服务运行中即可执行）
set -eu

BACKUP_DIR=${1:?"用法: backup.sh <备份目录>"}
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/cloud-monitor-backup-$TS"
mkdir -p "$OUT"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HUB_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
# 用项目目录加载 compose.yml + override.yml，避免 -f 单文件漏掉端口覆盖
COMPOSE="docker compose --project-directory $HUB_DIR"

container_running() {
  service="$1"
  cid=$($COMPOSE ps -q "$service" 2>/dev/null || true)
  [ -n "$cid" ] || return 1
  docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null | grep -qx true
}

echo "[1/3] 备份 tm-core devices.json（官方状态 + 订阅）..."
if ! container_running tm-core; then
  echo "tm-core 未运行，无法备份 devices.json" >&2
  exit 1
fi
if $COMPOSE exec -T tm-core sh -c 'test -f /data/devices.json'; then
  $COMPOSE exec -T tm-core cat /data/devices.json > "$OUT/devices.json"
else
  echo "{}" > "$OUT/devices.json"
  echo "devices.json 尚不存在，已写入空对象并继续备份数据库"
fi

echo "[2/3] 备份 SQLite（Python sqlite3.backup，流式落到宿主机）..."
if ! container_running cloud-hub; then
  echo "cloud-hub 未运行，无法备份 SQLite" >&2
  exit 1
fi
$COMPOSE exec -T cloud-hub python3 - <<'PY' > "$OUT/cloud-monitor.sqlite3"
import os
import sqlite3
import sys
import tempfile

src = sqlite3.connect("/data/cloud-monitor.sqlite3")
fd, path = tempfile.mkstemp(prefix="cm-backup-", suffix=".sqlite3", dir="/tmp")
os.close(fd)
try:
    dst = sqlite3.connect(path)
    src.backup(dst)
    dst.close()
    with open(path, "rb") as handle:
        sys.stdout.buffer.write(handle.read())
finally:
    src.close()
    try:
        os.unlink(path)
    except OSError:
        pass
PY
[ -s "$OUT/cloud-monitor.sqlite3" ] || { echo "SQLite 备份是空文件" >&2; exit 1; }

echo "[3/3] 备份 manifest（两卷时间点）..."
SQLITE_WARN=""
SQLITE_BUCKET=$(python3 - "$OUT/cloud-monitor.sqlite3" <<'PY'
import sqlite3, sys
try:
    con = sqlite3.connect(sys.argv[1])
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
} > "$OUT/BACKUP-MANIFEST.txt"

echo "备份完成: $OUT"
ls -la "$OUT"
