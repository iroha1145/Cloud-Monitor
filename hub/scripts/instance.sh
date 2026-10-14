#!/usr/bin/env bash
# 托管实例管理：在同一台服务器上给朋友跑独立的 Cloud Monitor。
# 实例与主实例共用本仓库代码，面板在线更新时由 self-update.sh 一并重建；
# 密钥、端口、compose 项目名与数据卷各自独立。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HUB="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="$(dirname "$HUB")"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<'EOF'
用法: hub/scripts/instance.sh <命令> [参数]

  add <名称> <宿主端口>   生成独立密钥与端口配置并启动（端口只绑 127.0.0.1）
  up <名称>               按当前代码重建并启动
  down <名称>             停止（保留数据）
  remove <名称>           停止并删除该实例的数据卷与配置（不可恢复）
  ps <名称>               查看容器状态
  logs <名称>             查看最近日志
  list                    列出托管实例及端口

名称：小写字母、数字、- 和 _（如 alice）；compose 项目名为 cm-<名称>。
EOF
  exit 2
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

instance_port() {
  sed -n -E 's/^[[:space:]]*-[[:space:]]*"127\.0\.0\.1:([0-9]+):7878".*/\1/p' \
    "$HUB/instances/$1/compose.override.yml" | head -n 1
}

port_taken() {
  local port="$1" name
  [[ "$port" == 7878 ]] && return 0
  while IFS= read -r name; do
    [[ "$(instance_port "$name")" == "$port" ]] && return 0
  done < <(cm_list_instances "$HUB")
  return 1
}

# override 的 !override 需要 Docker Compose v2.24.4 及以上；旧版会把端口追加
# 而不是替换，导致与主实例抢 7878。
require_compose_override_tag() {
  local raw major minor patch
  raw="$(docker compose version --short 2>/dev/null || true)"
  raw="${raw#v}"
  IFS=. read -r major minor patch <<<"$raw"
  patch="${patch%%[!0-9]*}"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]]; then
    echo "需要 Docker Compose v2.24.4 及以上（未检测到 docker compose 插件）" >&2
    exit 1
  fi
  if (( major < 2 || (major == 2 && (minor < 24 || (minor == 24 && ${patch:-0} < 4))) )); then
    echo "需要 Docker Compose v2.24.4 及以上（当前 $raw）" >&2
    exit 1
  fi
}

stamp_build_identity() {
  local envf="$1" ver="dev" sha
  if [[ -f "$INSTALL_DIR/VERSION" ]]; then
    ver="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
  fi
  sha="$(git -c "safe.directory=$INSTALL_DIR" -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  cm_write_build_identity "$envf" "$ver" "$sha"
  export CM_VERSION="$ver" CM_GIT_SHA="$sha"
}

cmd_add() {
  local name="${1:-}" port="${2:-}"
  [[ -n "$name" && -n "$port" ]] || usage
  if ! cm_valid_instance_name "$name"; then
    echo "非法实例名: $name（小写字母、数字、- 和 _，最多 32 个字符）" >&2
    exit 1
  fi
  if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1024 || 10#$port > 65535 )); then
    echo "端口必须是 1024–65535 的整数" >&2
    exit 1
  fi
  port=$((10#$port))
  local dir="$HUB/instances/$name"
  if [[ -e "$dir" || -L "$dir" ]]; then
    echo "实例已存在: $dir" >&2
    exit 1
  fi
  if port_taken "$port"; then
    echo "端口 $port 已被主实例或其他托管实例占用" >&2
    exit 1
  fi
  require_compose_override_tag

  local tz=""
  if [[ -f "$HUB/.env" ]]; then
    tz="$(sed -n -E 's/^DASHBOARD_TIME_ZONE=(.*)$/\1/p' "$HUB/.env" | tail -n 1)"
  fi

  umask 077
  mkdir -p "$HUB/instances"
  mkdir "$dir"
  cat >"$dir/.env" <<EOF
# 托管实例 $name 的独立密钥（由 instance.sh 生成，勿与主实例共用）
API_KEY=$(rand_hex)
ACCESS_TOKEN=$(rand_hex)
TOKEN_MONITOR_SECRET=$(rand_hex)
CM_DEMO=false
DASHBOARD_TIME_ZONE=${tz:-Asia/Tokyo}
EOF
  chmod 600 "$dir/.env"

  # 不挂载更新目录并指向不存在的路径：托管实例的面板只能检索版本，
  # 不能向宿主机提交更新；更新由主实例统一触发。
  cat >"$dir/compose.override.yml" <<EOF
# 托管实例 $name（由 instance.sh 生成）
services:
  cloud-hub:
    ports: !override
      - "127.0.0.1:$port:7878"
    environment:
      CM_UPDATE_DIR: /hosted-instance/update-disabled
      CM_UPDATE_RUNTIME_DIR: /hosted-instance/update-disabled
    volumes: !override
      - cloud-hub-data:/data
EOF

  echo "已创建托管实例 $name（端口 127.0.0.1:$port），正在启动..."
  cmd_up "$name"
  cat <<EOF

把下面的密钥发给对方（文件: $dir/.env）：
  token-monitor 同步密钥 TOKEN_MONITOR_SECRET = $(sed -n 's/^TOKEN_MONITOR_SECRET=//p' "$dir/.env")
  网页 / 安卓登录       ACCESS_TOKEN         = $(sed -n 's/^ACCESS_TOKEN=//p' "$dir/.env")
  OpenWebUI 同步（可选）API_KEY              = $(sed -n 's/^API_KEY=//p' "$dir/.env")

还需要在反代上给它一个独立子域名指向 127.0.0.1:$port（SSE 路径同样关闭缓冲）。
EOF
}

cmd_up() {
  local name="${1:-}"
  [[ -n "$name" ]] || usage
  cm_require_instance "$HUB" "$name"
  stamp_build_identity "$HUB/instances/$name/.env"
  cm_instance_compose "$HUB" "$name" up -d --build
}

cmd_down() {
  local name="${1:-}"
  [[ -n "$name" ]] || usage
  cm_require_instance "$HUB" "$name"
  cm_instance_compose "$HUB" "$name" down
}

cmd_remove() {
  local name="${1:-}" answer
  [[ -n "$name" ]] || usage
  cm_require_instance "$HUB" "$name"
  echo "将删除托管实例 $name 的全部数据（数据卷与 $HUB/instances/$name），不可恢复。"
  read -r -p "请输入实例名确认: " answer
  if [[ "$answer" != "$name" ]]; then
    echo "已取消" >&2
    exit 1
  fi
  cm_instance_compose "$HUB" "$name" down -v --rmi local
  rm -rf -- "$HUB/instances/$name"
  echo "已删除 $name"
}

cmd_ps() {
  local name="${1:-}"
  [[ -n "$name" ]] || usage
  cm_require_instance "$HUB" "$name"
  cm_instance_compose "$HUB" "$name" ps
}

cmd_logs() {
  local name="${1:-}"
  [[ -n "$name" ]] || usage
  cm_require_instance "$HUB" "$name"
  cm_instance_compose "$HUB" "$name" logs --tail 200
}

cmd_list() {
  local name found=0
  while IFS= read -r name; do
    found=1
    printf '%-24s 127.0.0.1:%s\n' "$name" "$(instance_port "$name")"
  done < <(cm_list_instances "$HUB")
  (( found )) || echo "（没有托管实例）"
}

command="${1:-}"
[[ -n "$command" ]] || usage
shift
case "$command" in
  add) cmd_add "$@" ;;
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  remove) cmd_remove "$@" ;;
  ps) cmd_ps "$@" ;;
  logs) cmd_logs "$@" ;;
  list) cmd_list ;;
  *) usage ;;
esac
