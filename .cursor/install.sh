#!/usr/bin/env bash
# Cloud Agent 环境安装脚本（幂等）：原生运行 Cloud Monitor 的 hub（FastAPI）
# 与 tm-core（vendored Node hub），无需 Docker。可重复执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1) venv 所需系统依赖（默认镜像自带 python3/node，但 ensurepip 可能缺失）
if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3-venv \
    || sudo apt-get install -y -qq "python3.$(python3 -c 'import sys;print(sys.version_info.minor)')-venv"
fi

# 2) 虚拟环境 + 依赖
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -q -r hub/requirements.txt -r agent/requirements.txt pytest

# 3) 生成 hub/.env（仅在缺失时）：三把互不相同的强随机密钥；默认演示模式
if [ ! -f hub/.env ]; then
  cp hub/.env.example hub/.env
  python3 - <<'PY'
import secrets, pathlib
p = pathlib.Path("hub/.env")
vals = {
    "API_KEY": secrets.token_hex(32),
    "ACCESS_TOKEN": secrets.token_hex(32),
    "TOKEN_MONITOR_SECRET": secrets.token_hex(32),
    "CM_DEMO": "true",  # 打开页面即见演示面板；实机开发改为 false 并用 ACCESS_TOKEN 登录
}
lines, seen = [], set()
for ln in p.read_text().splitlines():
    key = ln.split("=", 1)[0] if "=" in ln and not ln.strip().startswith("#") else None
    if key in vals:
        lines.append(f"{key}={vals[key]}"); seen.add(key)
    else:
        lines.append(ln)
for k, v in vals.items():
    if k not in seen:
        lines.append(f"{k}={v}")
p.write_text("\n".join(lines) + "\n")
PY
  chmod 600 hub/.env
  echo "已生成 hub/.env（强随机密钥，CM_DEMO=true）"
fi

# 4) 运行期数据目录
mkdir -p data

echo "安装完成：hub + agent 依赖就绪，hub/.env 已配置。"
