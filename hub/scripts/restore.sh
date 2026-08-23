#!/bin/sh
# 恢复：把两份备份写回两个独立卷，并校验时间点一致性。
# 用法: ./restore.sh <备份目录>（如 cloud-monitor-backup-20260823-120000）
set -eu

BACKUP=${1:?"用法: restore.sh <备份目录>"}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE="docker compose -f $SCRIPT_DIR/../docker-compose.yml"

[ -f "$BACKUP/devices.json" ] || { echo "缺少 devices.json"; exit 1; }
[ -f "$BACKUP/cloud-monitor.sqlite3" ] || { echo "缺少 cloud-monitor.sqlite3"; exit 1; }

echo "校验备份时间点..."
cat "$BACKUP/BACKUP-MANIFEST.txt" 2>/dev/null || true

echo "停止服务以保证一致性写入..."
$COMPOSE down

echo "恢复 tm-core devices.json..."
docker run --rm -v cloud-monitor_tm-core-data:/data -v "$BACKUP:/backup" alpine:3.21 \
  sh -c 'cp /backup/devices.json /data/devices.json'

echo "恢复 SQLite..."
docker run --rm -v cloud-monitor_cloud-hub-data:/data -v "$BACKUP:/backup" alpine:3.21 \
  sh -c 'cp /backup/cloud-monitor.sqlite3 /data/cloud-monitor.sqlite3 && rm -f /data/cloud-monitor.sqlite3-wal /data/cloud-monitor.sqlite3-shm'

echo "启动服务并验证..."
$COMPOSE up -d
sleep 5
$COMPOSE exec -T cloud-hub sh -c \
  'curl -sf http://127.0.0.1:7878/api/v1/health/ready' && echo ""
$COMPOSE exec -T tm-core sh -c \
  'wget -qO- http://127.0.0.1:17321/api/health' && echo ""

echo "恢复完成。请确认两卷时间点接近（见 BACKUP-MANIFEST.txt）。"
