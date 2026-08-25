#!/usr/bin/env bash
# Cloud Monitor 安装 / 切换脚本
#   演示：/ 直接打开假数据面板，无需密钥
#   实机：密钥门 + token-monitor 接入
# 再跑一遍本脚本即可从演示切到实机（或反过来）。
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/iroha1145/Cloud-Monitor.git}"
DEFAULT_DIR="/opt/cloud-monitor"
DIR_OVERRIDE=""
MODE=""
ASSUME_YES=0

usage() {
  cat <<'EOF'
用法: install.sh [--mode demo|live] [--yes] [--dir PATH]

  --mode demo   演示模式（假数据，打开页面即可）
  --mode live   实机模式（ACCESS_TOKEN 登录，接入本机 widget）
  --yes         非交互，沿用已有选择或 --mode
  --dir PATH    安装目录（默认：脚本所在仓库，否则 /opt/cloud-monitor）

不带参数时交互选择。已安装过再运行，可切换演示 ↔ 实机。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dir) DIR_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -n "$MODE" && "$MODE" != "demo" && "$MODE" != "live" ]]; then
  echo "--mode 只能是 demo 或 live" >&2
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "需要 Docker Compose（docker compose 或 docker-compose）" >&2
    exit 1
  fi
}

resolve_install_dir() {
  # 显式 --dir 永远最优先：此前从仓库 checkout 内运行时脚本目录会盖掉
  # 用户指定的目录，--dir 被静默忽略
  if [[ -n "$DIR_OVERRIDE" ]]; then
    echo "$DIR_OVERRIDE"
    return
  fi
  local self=""
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [[ -n "$self" && -f "$self/hub/docker-compose.yml" ]]; then
    echo "$self"
    return
  fi
  echo "$DEFAULT_DIR"
}

ensure_repo() {
  local dir="$1"
  if [[ -d "$dir/.git" && -f "$dir/hub/docker-compose.yml" ]]; then
    # fetch 失败（离线等）不致命：演示↔实机切换本来不需要远端
    if git -c "safe.directory=$dir" -C "$dir" fetch origin 2>/dev/null; then
      if git -c "safe.directory=$dir" -C "$dir" merge --ff-only origin/main; then
        :
      else
        echo "提示：未能快进到 origin/main，继续使用当前工作区。" >&2
      fi
    else
      echo "提示：无法访问远端仓库（离线？），跳过更新，继续使用当前工作区。" >&2
    fi
    return
  fi
  if [[ -e "$dir" && ! -d "$dir/.git" ]]; then
    echo "目录已存在且不是 git 仓库: $dir" >&2
    exit 1
  fi
  need_cmd git
  mkdir -p "$(dirname "$dir")"
  git clone "$REPO_URL" "$dir"
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

env_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  # `|| true` 必不可少：key 不存在时 grep 退出 1，在 set -euo pipefail 下
  # 会让 `api="$(env_get …)"` 赋值直接杀死脚本（无任何报错）——而这恰恰是
  # ensure_env 需要补生成该 key 的场景
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

upsert_env() {
  local file="$1" key="$2" value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    grep -v -E "^${key}=" "$file" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

ensure_env() {
  local envf="$1"
  local example="$2"
  if [[ ! -f "$envf" ]]; then
    if [[ -f "$example" ]]; then
      cp "$example" "$envf"
    else
      : >"$envf"
    fi
    chmod 600 "$envf"
  fi
  local api token tm
  api="$(env_get "$envf" API_KEY)"
  token="$(env_get "$envf" ACCESS_TOKEN)"
  tm="$(env_get "$envf" TOKEN_MONITOR_SECRET)"
  [[ -n "$api" ]] || upsert_env "$envf" API_KEY "$(rand_hex)"
  [[ -n "$token" ]] || upsert_env "$envf" ACCESS_TOKEN "$(rand_hex)"
  [[ -n "$tm" ]] || upsert_env "$envf" TOKEN_MONITOR_SECRET "$(rand_hex)"
}

read_mode_file() {
  local f="$1/.deploy-mode"
  if [[ -f "$f" ]]; then
    tr -d '[:space:]' <"$f"
  fi
}

pick_mode() {
  local current="$1"
  if [[ -n "$MODE" ]]; then
    echo "$MODE"
    return
  fi
  if [[ "$ASSUME_YES" == "1" && -n "$current" ]]; then
    echo "$current"
    return
  fi
  if [[ ! -t 0 ]]; then
    echo "非交互环境请使用 --mode demo 或 --mode live（如 curl … | sudo bash -s -- --mode demo）" >&2
    exit 1
  fi
  # 本函数被 CHOSEN="$(pick_mode …)" 命令替换调用：所有展示文本必须走
  # stderr。走 stdout 会被吞进 CHOSEN——用户看不到菜单，且多行串永远
  # 不等于 "demo"，选「演示」也会被装成实机
  {
    echo
    if [[ -n "$current" ]]; then
      local label="实机"
      [[ "$current" == "demo" ]] && label="演示"
      echo "当前部署：$label。再选一次即可切换。"
    else
      echo "选择安装模式："
    fi
    echo "  1) 演示  — 假数据预览面板，打开页面即可（无需密钥）"
    echo "  2) 实机  — ACCESS_TOKEN 登录，接入本机 token-monitor"
  } >&2
  local choice
  read -r -p "请输入 1 或 2: " choice
  case "$choice" in
    1|demo|DEMO) echo demo ;;
    2|live|LIVE|prod) echo live ;;
    *) echo "无效选择" >&2; exit 1 ;;
  esac
}

hub_url() {
  local dir="$1"
  local port="7878"
  local override="$dir/hub/docker-compose.override.yml"
  if [[ -f "$override" ]] && grep -q '5050:7878' "$override"; then
    port="5050"
  elif [[ -f "$override" ]]; then
    local found
    found="$(grep -Eo '127\.0\.0\.1:[0-9]+:7878' "$override" | head -n1 | cut -d: -f2 || true)"
    [[ -n "$found" ]] && port="$found"
  fi
  echo "http://127.0.0.1:${port}/"
}

need_cmd docker
INSTALL_DIR="$(resolve_install_dir)"
echo "安装目录：$INSTALL_DIR"
ensure_repo "$INSTALL_DIR"

HUB="$INSTALL_DIR/hub"
ENVF="$HUB/.env"
ensure_env "$ENVF" "$HUB/.env.example"

upsert_env "$ENVF" CM_VERSION "$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION" 2>/dev/null || echo dev)"
upsert_env "$ENVF" CM_GIT_SHA "$(git -c "safe.directory=$INSTALL_DIR" -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

ensure_updater() {
  mkdir -p "$HUB/update-control"
  chmod 777 "$HUB/update-control" 2>/dev/null || true
  chmod +x "$HUB/scripts/self-update.sh" "$HUB/scripts/update-watcher.sh" 2>/dev/null || true
  if command -v systemctl >/dev/null 2>&1 && [[ "$(id -u)" == "0" ]] && systemctl list-unit-files >/dev/null 2>&1; then
    local unit="/etc/systemd/system/cloud-monitor-updater.service"
    sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$HUB/scripts/systemd/cloud-monitor-updater.service" >"$unit"
    systemctl daemon-reload
    systemctl enable --now cloud-monitor-updater.service >/dev/null
    echo "已启用宿主机更新监视器（systemd）"
    return
  fi
  local pidf="$HUB/update-control/watcher.pid"
  if [[ -f "$pidf" ]] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "宿主机更新监视器已在运行"
    return
  fi
  nohup "$HUB/scripts/update-watcher.sh" "$INSTALL_DIR" \
    >>"$HUB/update-control/watcher.log" 2>&1 &
  echo $! >"$pidf"
  echo "已在后台启动宿主机更新监视器（pid $(cat "$pidf")）"
}
ensure_updater

CURRENT="$(read_mode_file "$INSTALL_DIR")"
CHOSEN="$(pick_mode "$CURRENT")"

if [[ "$CHOSEN" == "demo" ]]; then
  upsert_env "$ENVF" CM_DEMO true
else
  upsert_env "$ENVF" CM_DEMO false
fi
printf '%s\n' "$CHOSEN" >"$INSTALL_DIR/.deploy-mode"

echo "启动服务（docker compose up -d --build）…"
(
  cd "$HUB"
  compose up -d --build
)

URL="$(hub_url "$INSTALL_DIR")"
echo
if [[ "$CHOSEN" == "demo" ]]; then
  echo "已切换为演示模式。"
  echo "打开 $URL 即可预览（假数据，无需密钥）。"
  echo "公开演示：https://iroha1145.github.io/Cloud-Monitor/"
  echo "之后再运行本脚本，选「实机」即可关掉演示、改用 ACCESS_TOKEN。"
else
  echo "已切换为实机模式。"
  echo "面板：$URL"
  echo "用 hub/.env 里的 ACCESS_TOKEN 登录。"
  echo "本机 token-monitor 的 hub 填公网/反代地址，密钥填 TOKEN_MONITOR_SECRET。"
fi
echo
echo "在线检查：curl -sS ${URL}api/v1/health/live"
