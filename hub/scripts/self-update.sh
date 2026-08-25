#!/usr/bin/env bash
# 宿主机执行：按 update-control/request.json 的 ref 更新仓库并重建 compose。
# 不可在 cloud-hub 容器内运行（镜像只读、无 git、无 docker）。
set -euo pipefail

INSTALL_DIR="${1:-}"
if [[ -z "$INSTALL_DIR" || ! -d "$INSTALL_DIR/.git" ]]; then
  echo "用法: self-update.sh <安装目录>" >&2
  exit 2
fi

HUB="$INSTALL_DIR/hub"
CTRL="$HUB/update-control"
REQ="$CTRL/request.json"
STATUS="$CTRL/status.json"
LOCK="$CTRL/update.lock"
ENVF="$HUB/.env"

mkdir -p "$CTRL"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --project-directory "$HUB" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose --project-directory "$HUB" "$@"
  else
    echo "需要 Docker Compose" >&2
    return 1
  fi
}

iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_status() {
  local id="$1" state="$2" ref="$3" message="$4"
  python3 - "$STATUS" "$id" "$state" "$ref" "$message" "$(iso_now)" <<'PY'
import json, sys
path, rid, state, ref, message, ts = sys.argv[1:]
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(
        {"id": rid, "state": state, "ref": ref, "message": message, "updated_at": ts},
        f, ensure_ascii=False,
    )
    f.write("\n")
import os
os.replace(tmp, path)
PY
}

json_get() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")' "$1" "$2"
}

valid_ref() {
  local ref="$1"
  [[ "$ref" =~ ^(main|master|v?[0-9][A-Za-z0-9._-]{0,64})$ ]] || return 1
  [[ "$ref" != *..* ]] || return 1
}

if [[ ! -f "$REQ" ]]; then
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "已有更新在进行，跳过"
  exit 0
fi

ID="$(json_get "$REQ" id)"
REF="$(json_get "$REQ" ref)"
[[ -n "$ID" ]] || ID="unknown"
if ! valid_ref "$REF"; then
  write_status "$ID" error "$REF" "非法更新目标"
  rm -f "$REQ"
  exit 1
fi

write_status "$ID" running "$REF" "正在拉取 $REF"

cleanup_req() { rm -f "$REQ"; }
trap cleanup_req EXIT

git_in() {
  git -c "safe.directory=$INSTALL_DIR" -C "$INSTALL_DIR" "$@"
}

fail() {
  write_status "$ID" error "$REF" "$1"
  exit 1
}

if ! dirty="$(git_in status --porcelain --untracked-files=no)"; then
  fail "git status 失败（检查仓库目录所有权）"
fi
if [[ -n "$dirty" ]]; then
  fail "已跟踪文件有未提交改动，拒绝覆盖"
fi

if ! git_in fetch origin --tags --force; then
  fail "git fetch 失败"
fi
if [[ "$REF" == "main" || "$REF" == "master" ]]; then
  git_in checkout -q "$REF" || fail "无法 checkout $REF"
  git_in merge --ff-only "origin/$REF" || fail "无法快进到 origin/$REF"
else
  git_in checkout -q --detach "$REF" || fail "无法检出 $REF"
fi

VER="dev"
if [[ -f "$INSTALL_DIR/VERSION" ]]; then
  VER="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
fi
SHA="$(git_in rev-parse --short HEAD)"

if [[ -f "$ENVF" ]]; then
  grep -v -E '^(CM_VERSION|CM_GIT_SHA)=' "$ENVF" >"$ENVF.tmp" || true
  printf 'CM_VERSION=%s\nCM_GIT_SHA=%s\n' "$VER" "$SHA" >>"$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
  chmod 600 "$ENVF"
fi

write_status "$ID" running "$REF" "正在重建容器（$VER $SHA）"
(
  cd "$HUB"
  export CM_VERSION="$VER" CM_GIT_SHA="$SHA"
  compose up -d --build
)

write_status "$ID" ok "$REF" "已更新到 $REF（$VER $SHA）。请刷新面板。"
