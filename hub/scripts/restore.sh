#!/usr/bin/env bash
# 恢复：把两份备份写回两个独立卷，并校验时间点一致性。
# 用法: ./restore.sh [--instance 名称] <备份目录>（如 cloud-monitor-backup-20260823-120000）
#       --instance 恢复到 hub/instances/<名称> 托管实例，缺省为主实例
set -eu

INSTANCE=""
if [ "${1:-}" = "--instance" ]; then
  INSTANCE=${2:?"用法: restore.sh [--instance 名称] <备份目录>"}
  shift 2
fi
BACKUP=${1:?"用法: restore.sh [--instance 名称] <备份目录>"}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HUB_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

if [ -n "$INSTANCE" ]; then
  cm_require_instance "$HUB_DIR" "$INSTANCE"
fi

compose() {
  if [ -n "$INSTANCE" ]; then
    cm_instance_compose "$HUB_DIR" "$INSTANCE" "$@"
  else
    cm_compose "$HUB_DIR" "$@"
  fi
}

[ -f "$BACKUP/devices.json" ] || { echo "缺少 devices.json" >&2; exit 1; }
[ -f "$BACKUP/cloud-monitor.sqlite3" ] || { echo "缺少 cloud-monitor.sqlite3" >&2; exit 1; }
# compose run -v 相对的是工程目录；收成绝对路径再挂 /backup
BACKUP=$(CDPATH= cd -- "$BACKUP" && pwd)

# 恢复写入依赖 compose run --cap-add（服务声明 cap_drop ALL）：较老的
# compose 没有该旗标，必须在 down 之前失败，否则报错时服务已停机
if ! compose run --help 2>/dev/null | grep -q -- '--cap-add'; then
  echo "当前 docker compose 的 run 子命令不支持 --cap-add，请先升级 Docker Compose" >&2
  exit 1
fi

resolve_named_volume() {
  logical="$1"
  if [ -n "$INSTANCE" ]; then
    # 托管实例的项目名固定为 cm-<名称>；找不到就失败，绝不回退到主实例的卷。
    candidate="cm-${INSTANCE}_${logical}"
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
    echo "找不到托管实例 $INSTANCE 的卷 $candidate" >&2
    exit 1
  fi
  proj=""
  if command -v python3 >/dev/null 2>&1; then
    proj=$(compose config --format json 2>/dev/null | python3 -c '
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
compose down

echo "恢复 tm-core devices.json..."
# 用各镜像自身执行写入：容器内以 root 运行 cp 后按镜像内服务用户 chown，
# 否则文件属主 root、hub(tm-core) 进程只读，SQLite 打开即 "readonly database"。
# compose 服务声明了 cap_drop ALL + read_only：无 DAC_OVERRIDE/CHOWN 时
# uid 0 也写不进 monitor 属主的 /data。显式挂备份目录（服务本身没有 /backup）。
compose run --rm --no-deps --user=0 \
  --cap-add=DAC_OVERRIDE --cap-add=CHOWN --cap-add=FOWNER \
  -v "$BACKUP:/backup:ro" \
  --entrypoint sh tm-core -c \
  'cp /backup/devices.json /data/devices.json && chown "$(id -u monitor):$(id -g monitor)" /data/devices.json'

echo "恢复 SQLite..."
compose run --rm --no-deps --user=0 \
  --cap-add=DAC_OVERRIDE --cap-add=CHOWN --cap-add=FOWNER \
  -v "$BACKUP:/backup:ro" \
  --entrypoint sh cloud-hub -c \
  'cp /backup/cloud-monitor.sqlite3 /data/cloud-monitor.sqlite3 && rm -f /data/cloud-monitor.sqlite3-wal /data/cloud-monitor.sqlite3-shm && chown "$(id -u monitor):$(id -g monitor)" /data/cloud-monitor.sqlite3'

echo "启动服务并验证..."
compose up -d

# 容器内无 curl/wget（python-slim / node-slim），用镜像自带运行时探活；
# 服务有 start-period，轮询等待而不是固定 sleep 后一锤定音。
# compose exec 直连 argv，不经 shell 拼接；探活脚本内不含宿主机变量
hub_ready() {
  for _ in $(seq 1 30); do
    if compose exec -T cloud-hub python -c \
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
    if compose exec -T tm-core node -e \
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
