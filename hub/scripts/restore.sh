#!/bin/sh
# 恢复：把两份备份写回两个独立卷，并校验时间点一致性。
# 用法: ./restore.sh <备份目录>（如 cloud-monitor-backup-20260823-120000）
set -eu

BACKUP=${1:?"用法: restore.sh <备份目录>"}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HUB_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE="docker compose --project-directory $HUB_DIR"

[ -f "$BACKUP/devices.json" ] || { echo "缺少 devices.json" >&2; exit 1; }
[ -f "$BACKUP/cloud-monitor.sqlite3" ] || { echo "缺少 cloud-monitor.sqlite3" >&2; exit 1; }

resolve_named_volume() {
  logical="$1"
  proj=""
  if command -v python3 >/dev/null 2>&1; then
    proj=$($COMPOSE config --format json 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("name") or "")
except Exception:
    print("")
' || true)
  fi
  [ -n "$proj" ] || proj=$(basename "$HUB_DIR")
  candidate="${proj}_${logical}"
  if docker volume inspect "$candidate" >/dev/null 2>&1; then
    echo "$candidate"
    return
  fi
  for p in cloud-monitor hub; do
    if docker volume inspect "${p}_${logical}" >/dev/null 2>&1; then
      echo "${p}_${logical}"
      return
    fi
  done
  echo "找不到卷 ${logical}（试过 ${candidate}）" >&2
  docker volume ls >&2
  exit 1
}

TM_VOL=$(resolve_named_volume tm-core-data)
HUB_VOL=$(resolve_named_volume cloud-hub-data)

echo "校验备份时间点..."
cat "$BACKUP/BACKUP-MANIFEST.txt" 2>/dev/null || true
echo "将写入卷: $TM_VOL / $HUB_VOL"

echo "停止服务以保证一致性写入..."
$COMPOSE down

echo "恢复 tm-core devices.json..."
docker run --rm -v "$TM_VOL:/data" -v "$BACKUP:/backup" alpine:3.21 \
  sh -c 'cp /backup/devices.json /data/devices.json'

echo "恢复 SQLite..."
docker run --rm -v "$HUB_VOL:/data" -v "$BACKUP:/backup" alpine:3.21 \
  sh -c 'cp /backup/cloud-monitor.sqlite3 /data/cloud-monitor.sqlite3 && rm -f /data/cloud-monitor.sqlite3-wal /data/cloud-monitor.sqlite3-shm'

echo "启动服务并验证..."
$COMPOSE up -d
sleep 5
$COMPOSE exec -T cloud-hub sh -c \
  'curl -sf http://127.0.0.1:7878/api/v1/health/ready' && echo ""
$COMPOSE exec -T tm-core sh -c \
  'wget -qO- http://127.0.0.1:17321/api/health' && echo ""

echo "恢复完成。请确认两卷时间点接近（见 BACKUP-MANIFEST.txt）。"
