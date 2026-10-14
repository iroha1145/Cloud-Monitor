#!/usr/bin/env bash
# 运维脚本共享库：compose 探测、更新锁初始化与托管实例。
# 由 install.sh 与 hub/scripts/ 下的运维脚本 source，不单独执行。

cm_compose() {
  # 第一个参数固定为 compose 项目目录：目录是显式契约，不依赖调用方记得先 cd。
  local project_dir="$1"
  shift
  if docker compose version >/dev/null 2>&1; then
    docker compose --project-directory "$project_dir" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose --project-directory "$project_dir" "$@"
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

# 把面板显示的版本写进 env 文件（文件不存在时跳过）。
cm_write_build_identity() {
  local envf="$1" ver="$2" sha="$3"
  [[ -f "$envf" ]] || return 0
  grep -v -E '^(CM_VERSION|CM_GIT_SHA)=' "$envf" >"$envf.tmp" || true
  printf 'CM_VERSION=%s\nCM_GIT_SHA=%s\n' "$ver" "$sha" >>"$envf.tmp"
  mv "$envf.tmp" "$envf"
  chmod 600 "$envf"
}

# 托管实例：hub/instances/<名称>/ 下放 .env 与 compose.override.yml，
# 与主实例共用同一份代码和镜像构建上下文，项目名、密钥、端口与数据卷各自独立。
# 名称同时用作 compose 项目名后缀，只能是小写字母、数字、- 和 _。
cm_valid_instance_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]
}

cm_require_instance() {
  local hub_dir="$1" name="$2"
  if ! cm_valid_instance_name "$name"; then
    echo "非法实例名: $name（小写字母、数字、- 和 _，最多 32 个字符）" >&2
    return 1
  fi
  local dir="$hub_dir/instances/$name"
  if [[ -L "$dir" || ! -f "$dir/.env" || ! -f "$dir/compose.override.yml" ]]; then
    echo "找不到托管实例: $name（需要 $dir/.env 与 compose.override.yml）" >&2
    return 1
  fi
}

cm_list_instances() {
  local hub_dir="$1" dir name
  for dir in "$hub_dir"/instances/*/; do
    dir="${dir%/}"
    [[ -d "$dir" && ! -L "$dir" ]] || continue
    name="$(basename "$dir")"
    cm_require_instance "$hub_dir" "$name" 2>/dev/null || continue
    printf '%s\n' "$name"
  done
}

cm_instance_compose() {
  # 显式 --env-file 时 compose 不再读取 hub/.env，主实例的密钥不会混入。
  local hub_dir="$1" name="$2"
  shift 2
  local dir="$hub_dir/instances/$name"
  cm_compose "$hub_dir" -p "cm-$name" \
    -f "$hub_dir/docker-compose.yml" -f "$dir/compose.override.yml" \
    --env-file "$dir/.env" "$@"
}
