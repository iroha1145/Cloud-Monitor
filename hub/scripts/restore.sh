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
# compose run -v 相对的是工程目录；收成绝对路径再挂 /backup
BACKUP=$(CDPATH= cd -- "$BACKUP" && pwd)

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
# 用各镜像自身执行写入：容器内以 root 运行 cp 后按镜像内服务用户 chown，
# 否则文件属主 root、hub(tm-core) 进程只读，SQLite 打开即 "readonly database"。
# compose 服务声明了 cap_drop ALL + read_only：无 DAC_OVERRIDE/CHOWN 时
# uid 0 也写不进 monitor 属主的 /data。显式挂备份目录（服务本身没有 /backup）。
$COMPOSE run --rm --no-deps --user=0 \
  --cap-add=DAC_OVERRIDE --cap-add=CHOWN --cap-add=FOWNER \
  -v "$BACKUP:/backup:ro" \
  --entrypoint sh tm-core -c \
  'cp /backup/devices.json /data/devices.json && chown "$(id -u monitor):$(id -g monitor)" /data/devices.json'

echo "恢复 SQLite..."
$COMPOSE run --rm --no-deps --user=0 \
  --cap-add=DAC_OVERRIDE --cap-add=CHOWN --cap-add=FOWNER \
  -v "$BACKUP:/backup:ro" \
  --entrypoint sh cloud-hub -c \
  'cp /backup/cloud-monitor.sqlite3 /data/cloud-monitor.sqlite3 && rm -f /data/cloud-monitor.sqlite3-wal /data/cloud-monitor.sqlite3-shm && chown "$(id -u monitor):$(id -g monitor)" /data/cloud-monitor.sqlite3'

echo "启动服务并验证..."
$COMPOSE up -d

# 容器内无 curl/wget（python-slim / node-slim），用镜像自带运行时探活；
# 服务有 start-period，轮询等待而不是固定 sleep 后一锤定音。
# compose exec 直连 argv，不经 shell 拼接；探活脚本内不含宿主机变量
hub_ready() {
  for _ in $(seq 1 30); do
    if $COMPOSE exec -T cloud-hub python -c \
      "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7878/api/v1/health/ready', timeout=4).status == 200 else 1)" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

tm_ready() {
  for _ in $(seq 1 30); do
    if $COMPOSE exec -T tm-core node -e \
      "fetch('http://127.0.0.1:17321/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! hub_ready; then
  echo "cloud-hub 30s 内未就绪，恢复验证失败" >&2
  exit 1
fi
echo "cloud-hub 就绪"

if ! tm_ready; then
  echo "tm-core 30s 内未就绪，恢复验证失败" >&2
  exit 1
fi
echo "tm-core 就绪"

echo "恢复完成。请确认两卷时间点接近（见 BACKUP-MANIFEST.txt）。"
