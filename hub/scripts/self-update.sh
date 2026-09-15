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
RUNTIME="${CM_UPDATE_RUNTIME_HOST:-${CM_UPDATE_RUNTIME_DIR:-/run/cloud-monitor}}"
STATUS="$RUNTIME/status.json"
LOCK="$RUNTIME/update.lock"
ENVF="$HUB/.env"

mkdir -p "$CTRL"
if ! mkdir -p "$RUNTIME"; then
  echo "无法创建更新运行时目录: $RUNTIME" >&2
  exit 1
fi
chmod 700 "$RUNTIME" || true

refuse_symlink() {
  local path="$1"
  if [[ -L "$path" ]]; then
    echo "拒绝符号链接: $path" >&2
    return 1
  fi
}

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
  refuse_symlink "$STATUS" || return 1
  refuse_symlink "$STATUS.tmp" || return 1
  python3 - "$STATUS" "$id" "$state" "$ref" "$message" "$(iso_now)" <<'PY'
import json, os, sys
path, rid, state, ref, message, ts = sys.argv[1:]
if os.path.islink(path) or os.path.islink(os.path.dirname(path)):
    raise SystemExit("refusing symlink status path")
tmp = path + ".tmp"
if os.path.islink(tmp):
    raise SystemExit("refusing symlink status tmp")
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(tmp, flags, 0o644)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(
        {"id": rid, "state": state, "ref": ref, "message": message, "updated_at": ts},
        f, ensure_ascii=False,
    )
    f.write("\n")
os.replace(tmp, path)
PY
}

json_get() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")' "$1" "$2"
}

valid_ref() {
  local ref="$1"
  [[ "$ref" != *$'\t'* ]] || return 1
  [[ ${#ref} -le 66 ]] || return 1
  [[ "$ref" =~ ^(main|master|v?[0-9]+(\.[0-9A-Za-z_-]+)*)$ ]] || return 1
  [[ "$ref" != *..* ]] || return 1
  [[ ! "$ref" =~ ^[0-9a-fA-F]{40}$ ]] || return 1
}

if [[ ! -f "$REQ" ]]; then
  exit 0
fi
if [[ -L "$REQ" || -L "$CTRL" ]]; then
  echo "拒绝符号链接控制文件" >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  ID="$(json_get "$REQ" id)"
  REF="$(json_get "$REQ" ref)"
  [[ -n "$ID" ]] || ID="unknown"
  write_status "$ID" error "$REF" "宿主机缺少 flock，无法安全串行更新"
  # 中断保留 request，供修好 flock 后重试（与 trap 约定一致）。
  exit 1
fi

refuse_symlink "$LOCK" || exit 1
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
FINAL_STATE=""

cleanup_req() {
  rm -f "$REQ"
  if [[ -z "$FINAL_STATE" ]]; then
    write_status "$ID" error "$REF" "更新中断，请重试" || true
  fi
}
trap cleanup_req EXIT

git_in() {
  git -c "safe.directory=$INSTALL_DIR" -C "$INSTALL_DIR" "$@"
}

fail() {
  write_status "$ID" error "$REF" "$1"
  FINAL_STATE=error
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
  git_in checkout -q --detach "refs/tags/$REF" || fail "无法检出标签 $REF"
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
) || fail "容器重建失败（代码已更新，服务未重启）"

write_status "$ID" ok "$REF" "已更新到 $REF（$VER $SHA）。请刷新面板。"
FINAL_STATE=ok
