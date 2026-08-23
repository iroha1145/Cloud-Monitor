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
COMPOSE="docker compose -f $SCRIPT_DIR/../docker-compose.yml"

echo "[1/3] 备份 tm-core devices.json（官方状态 + 订阅）..."
$COMPOSE exec -T tm-core sh -c 'cat /data/devices.json' > "$OUT/devices.json"

echo "[2/3] 备份 SQLite（.backup 一致性快照，含 WAL）..."
CID=$($COMPOSE ps -q cloud-hub)
docker exec "$CID" sh -c \
  'sqlite3 /data/cloud-monitor.sqlite3 ".backup /tmp/cloud-monitor.sqlite3"' 2>/dev/null || \
  docker run --rm --volumes-from "$CID" -v "$OUT:/backup" alpine:3.21 sh -c \
  'apk add --no-cache sqlite >/dev/null && sqlite3 /data/cloud-monitor.sqlite3 ".backup /backup/cloud-monitor.sqlite3"'
docker exec "$CID" sh -c 'cat /tmp/cloud-monitor.sqlite3' > "$OUT/cloud-monitor.sqlite3" 2>/dev/null || true

echo "[3/3] 备份 manifest（两卷时间点）..."
{
  echo "backup_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tm-core devices.json saved_at:"
  grep -o '"savedAt": *"[^"]*"' "$OUT/devices.json" | head -1 || true
  echo "sqlite latest bucket:"
  sqlite3 "$OUT/cloud-monitor.sqlite3" \
    "SELECT MAX(bucket_start) FROM tm_snapshot_buckets;" 2>/dev/null || true
} > "$OUT/BACKUP-MANIFEST.txt"

echo "备份完成: $OUT"
ls -la "$OUT"
