#!/usr/bin/env bash
# 宿主机监视器：发现 request.json 就调用 self-update.sh。
# install.sh 会以 systemd 或 nohup 拉起。
set -euo pipefail

INSTALL_DIR="${1:-}"
if [[ -z "$INSTALL_DIR" ]]; then
  echo "用法: update-watcher.sh <安装目录>" >&2
  exit 2
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CTRL="$INSTALL_DIR/hub/update-control"
mkdir -p "$CTRL"

echo "cloud-monitor updater 监视 $CTRL"
while true; do
  if [[ -f "$CTRL/request.json" ]]; then
    "$SCRIPT_DIR/self-update.sh" "$INSTALL_DIR" || true
  fi
  sleep 2
done
