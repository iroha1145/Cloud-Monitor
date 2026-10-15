#!/bin/sh
# Fixed paths and validated tenant names only; no backup content is shell code.
set -eu

backup=${1:?}
data=${2:?}
target_uid=${3:?}
target_gid=${4:?}

plain_directory() {
  [ ! -L "$1" ] && [ -d "$1" ] || { echo "拒绝非目录或符号链接: $1" >&2; exit 1; }
}

plain_file() {
  [ ! -L "$1" ] && [ -f "$1" ] || { echo "拒绝非普通文件或符号链接: $1" >&2; exit 1; }
}

check_target() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    plain_file "$1"
  fi
}

plain_directory "$backup"
plain_directory "$data"
plain_file "$backup/devices.json"
check_target "$data/devices.json"
if [ -e "$data/tenants" ] || [ -L "$data/tenants" ]; then
  plain_directory "$data/tenants"
fi
if [ -e "$backup/tenants" ] || [ -L "$backup/tenants" ]; then
  plain_directory "$backup/tenants"
  for directory in "$backup"/tenants/*; do
    [ -e "$directory" ] || [ -L "$directory" ] || continue
    plain_directory "$directory"
    tenant=${directory##*/}
    case "$tenant" in
      ''|default|*[!A-Za-z0-9_-]*) echo "非法租户 ID: $tenant" >&2; exit 1 ;;
    esac
    [ "${#tenant}" -le 64 ] || { echo "非法租户 ID: $tenant" >&2; exit 1; }
    if [ -e "$directory/devices.json" ] || [ -L "$directory/devices.json" ]; then
      plain_file "$directory/devices.json"
      if [ -e "$data/tenants/$tenant" ] || [ -L "$data/tenants/$tenant" ]; then
        plain_directory "$data/tenants/$tenant"
      fi
      check_target "$data/tenants/$tenant/devices.json"
    fi
  done
fi

copy_state() {
  source_file=$1
  destination=$2
  temporary=$(mktemp "${destination%/*}/.cm-restore-XXXXXX")
  if ! cp "$source_file" "$temporary" || ! chmod 600 "$temporary" || ! chown "$target_uid:$target_gid" "$temporary"; then
    rm -f -- "$temporary"
    exit 1
  fi
  mv -f -- "$temporary" "$destination"
}

umask 077
copy_state "$backup/devices.json" "$data/devices.json"
for directory in "$backup"/tenants/*; do
  [ -f "$directory/devices.json" ] || continue
  tenant=${directory##*/}
  mkdir -p "$data/tenants/$tenant"
  chown "$target_uid:$target_gid" "$data/tenants" "$data/tenants/$tenant"
  copy_state "$directory/devices.json" "$data/tenants/$tenant/devices.json"
done
