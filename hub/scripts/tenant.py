#!/usr/bin/env python3
"""Manage the static tenant keys in hub/.env; never restart services or delete data."""

from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
import errno
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile

if os.name == "nt":
    import msvcrt
else:
    import fcntl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from hub.config import (  # noqa: E402
    ConfigError,
    TENANT_ID_RE,
    parse_tenants,
    validate_secret,
)


ENV_KEYS = {
    "ACCESS_TOKEN", "TOKEN_MONITOR_SECRET", "TENANTS_JSON",
}
ASSIGNMENT = re.compile(r"^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$")


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError(f"JSON 中存在重复字段：{key}")
        result[key] = value
    return result


def env_value(raw: str, key: str) -> tuple[str, str]:
    """Read the single-line literal values used by the generated Compose env file."""
    if not raw or raw.startswith("#"):
        return "", raw
    if raw.startswith("'"):
        value, index = [], 1
        while index < len(raw):
            if raw[index:index + 2] == "\\'":
                value.append("'")
                index += 2
            elif raw[index] == "'":
                tail = raw[index + 1:]
                break
            else:
                value.append(raw[index])
                index += 1
        else:
            raise ConfigError(f"{key} 的单引号未闭合（仅支持单行配置）")
        decoded = "".join(value)
    elif raw.startswith('"') or (key.endswith("_JSON") and raw.startswith(("{", "["))):
        value, end = json.JSONDecoder().raw_decode(raw)
        decoded = value if isinstance(value, str) else raw[:end]
        tail = raw[end:]
    else:
        parts = re.split(r"(\s+#.*)", raw, maxsplit=1)
        decoded, tail = parts[0].rstrip(), "".join(parts[1:])
    if tail.strip() and not tail.lstrip().startswith("#"):
        raise ConfigError(f"{key} 的值后存在无法识别的内容")
    if not raw.startswith("'") and re.search(r"\$(?:[A-Za-z_]|\{)", decoded):
        raise ConfigError(f"{key} 含 Compose 变量引用，请改成单引号包住的实际值")
    return decoded, tail


def refuse_symlinks(path: Path) -> None:
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ConfigError("拒绝符号链接 env 文件或目录")


@contextmanager
def env_lock(path: Path):
    path = path.expanduser().absolute()
    lock_path = path.with_name(path.name + ".lock")
    refuse_symlinks(path)
    refuse_symlinks(lock_path)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "r+b", buffering=0) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ConfigError("env 锁路径必须是普通文件")
        if os.name == "nt":
            os.chmod(lock_path, 0o600)
            if info.st_size == 0:
                handle.write(b"\0")
            handle.seek(0)
        else:
            os.fchmod(handle.fileno(), 0o600)
        try:
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise ConfigError("env 配置正由其他操作修改，请稍后重试") from exc
            raise
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_private_file(path: Path) -> tuple[bytes, os.stat_result]:
    refuse_symlinks(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ConfigError("env 路径必须是普通文件")
        return handle.read(), info


class EnvFile:
    def __init__(self, path: Path):
        self.path = path.expanduser().absolute()
        self.original, self.info = read_private_file(self.path)
        self.lines = self.original.decode("utf-8").splitlines(keepends=True)
        self.values: dict[str, str] = {}
        self.index: int | None = None
        self.prefix, self.tail = "TENANTS_JSON=", ""
        for index, line in enumerate(self.lines):
            match = ASSIGNMENT.match(line.rstrip("\r\n"))
            if match is None or match[2] not in ENV_KEYS:
                continue
            key = match[2]
            if key in self.values:
                raise ConfigError(f"env 中重复配置了 {key}")
            self.values[key], tail = env_value(match[3], key)
            if key == "TENANTS_JSON":
                self.index, self.prefix, self.tail = index, match[1], tail
        raw = self.values.get("TENANTS_JSON", "")
        self.tenants = json.loads(raw, object_pairs_hook=unique_object) if raw else {}
        if not isinstance(self.tenants, dict):
            raise ConfigError("TENANTS_JSON 必须是对象")
        for tenant_id in self.tenants:
            if tenant_id != tenant_id.strip():
                raise ConfigError("租户 ID 不得包含首尾空白，请先修正原始配置")
        self.validate()

    def validate(self) -> dict[str, str]:
        tenants = parse_tenants(json.dumps(self.tenants))
        access_token = self.values.get("ACCESS_TOKEN", "").strip()
        keys = {"ACCESS_TOKEN": access_token}
        tm_secret = self.values.get("TOKEN_MONITOR_SECRET", "").strip()
        if tm_secret:
            keys["TOKEN_MONITOR_SECRET"] = tm_secret
        for tenant_id, tenant in tenants.items():
            keys[f"TENANTS_JSON[{tenant_id}].tm_secret"] = tenant.tm_secret
            keys[f"TENANTS_JSON[{tenant_id}].access_token"] = tenant.access_token
        seen: dict[str, str] = {}
        for name, value in keys.items():
            validate_secret(name, value)
            if value in seen:
                raise ConfigError(f"密钥 {name} 与 {seen[value]} 相同：不同用途必须使用不同密钥")
            seen[value] = name
        return keys

    def new_keys(self) -> dict[str, str]:
        used = set(self.validate().values())
        result = {}
        for field in ("tm_secret", "access_token"):
            value = secrets.token_hex(32)
            while value in used:
                value = secrets.token_hex(32)
            used.add(value)
            result[field] = value
        return result

    def save(self) -> None:
        self.validate()
        # JSON escapes apostrophes so the enclosing Compose single quotes never
        # need shell-style escaping; dollar signs stay literal inside that value.
        payload = json.dumps(self.tenants, ensure_ascii=True, separators=(",", ":")).replace("'", "\\u0027")
        newline = "\r\n" if self.original.count(b"\r\n") else "\n"
        tail = self.tail if not self.tail.startswith("#") else " " + self.tail
        replacement = f"{self.prefix}'{payload}'{tail}"
        lines = self.lines[:]
        if self.index is None:
            if lines and not lines[-1].endswith(("\n", "\r")):
                lines[-1] += newline
            lines.append(replacement + newline)
        else:
            ending = "\r\n" if lines[self.index].endswith("\r\n") else "\n" if lines[self.index].endswith("\n") else ""
            lines[self.index] = replacement + ending
        fd, temporary = tempfile.mkstemp(prefix=".tenant-env-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                os.chmod(temporary, 0o600)
                handle.write("".join(lines).encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            current, info = read_private_file(self.path)
            if current != self.original or (info.st_dev, info.st_ino) != (self.info.st_dev, self.info.st_ino):
                raise ConfigError("env 文件已被其他操作修改，请重新执行命令")
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def show(tenant_id: str, entry: dict) -> None:
    print(f"租户：{tenant_id}（权限：{entry.get('role') or 'user'}）")
    print(f"token-monitor 同步密钥 tm_secret：{entry['tm_secret']}")
    print(f"网页 / 安卓访问密钥 access_token：{entry['access_token']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="列出租户与权限，不输出密钥")
    for command in ("add", "show", "rotate", "remove"):
        commands.add_parser(command).add_argument("tenant_id")
    args = parser.parse_args()
    try:
        with (nullcontext() if args.command in ("list", "show") else env_lock(args.env_file)):
            env = EnvFile(args.env_file)
            if args.command == "list":
                for tenant_id, entry in env.tenants.items():
                    print(f"{tenant_id}\t{entry.get('role') or 'user'}")
                if not env.tenants:
                    print("暂无租户")
                return 0
            tenant_id = args.tenant_id
            if not TENANT_ID_RE.fullmatch(tenant_id) or tenant_id == "default":
                raise ConfigError("非法租户 ID：仅允许 1–64 位字母、数字、_、-，且不能为 default")
            if args.command == "add":
                if tenant_id in env.tenants:
                    raise ConfigError(f"租户已存在：{tenant_id}")
                env.tenants[tenant_id] = {**env.new_keys(), "role": "user"}
            elif tenant_id not in env.tenants:
                raise ConfigError(f"找不到租户：{tenant_id}")
            elif args.command == "rotate":
                env.tenants[tenant_id].update(env.new_keys())
            elif args.command == "remove":
                del env.tenants[tenant_id]
            if args.command != "show":
                env.save()
            if args.command == "remove":
                print(f"已撤销租户 {tenant_id} 的配置，历史数据保留；重新使用同一 ID 会读到原数据。")
            else:
                show(tenant_id, env.tenants[tenant_id])
            if args.command != "show":
                print("请在 hub 目录执行 docker compose up -d --force-recreate，让两个服务加载新配置；生效前原密钥仍可用。")
        return 0
    except (ConfigError, OSError, UnicodeError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
