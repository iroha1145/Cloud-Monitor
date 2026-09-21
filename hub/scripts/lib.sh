#!/usr/bin/env bash
# 运维脚本共享库：compose 探测与更新锁初始化。
# 由 install.sh 与 hub/scripts/self-update.sh source，不单独执行。

cm_compose() {
  # 调用方先 cd 到 compose 项目目录，再调用本函数。
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "需要 Docker Compose（docker compose 或 docker-compose）" >&2
    return 1
  fi
}

cm_init_update_lock() {
  # 更新锁保留同一 inode：已有 watcher 可能正持锁，不能替换或截断。
  python3 - "$1" <<'PY'
import os, stat, sys
path = sys.argv[1]
fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW, 0o640)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise SystemExit("更新锁必须是普通文件")
    os.fchown(fd, 0, 999)
    os.fchmod(fd, 0o640)
finally:
    os.close(fd)
PY
}
