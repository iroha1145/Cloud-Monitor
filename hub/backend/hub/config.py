from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

# 同步协议版本：v2 = source_instance_id + 指纹冲突检测 + 游标心跳
PROTOCOL_VERSION = 2

WEAK_API_KEYS = {"changeme", "please-change-me", "password", "secret", "123456"}
MIN_API_KEY_LENGTH = 32


class ConfigError(Exception):
    """环境配置非法，应用必须拒绝启动。"""


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_frontend_dir() -> Path:
    return _project_root() / "frontend"


def _default_database_path() -> Path:
    return _project_root() / "data" / "cloud-monitor.sqlite3"


def _env_bool(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


def validate_secret(name: str, value: str) -> None:
    if not value:
        raise ConfigError(f"{name} 未配置")
    if value in WEAK_API_KEYS:
        raise ConfigError(f"{name} 是弱默认值，请更换为强随机值")
    if len(value) < MIN_API_KEY_LENGTH:
        raise ConfigError(
            f"{name} 长度不足（最少 {MIN_API_KEY_LENGTH} 个随机字符，"
            "建议 `openssl rand -hex 32`）"
        )


validate_api_key = validate_secret


def parse_device_keys(raw: str | None) -> dict[str, str]:
    """解析 DEVICE_KEYS_JSON：{"device-id": "write-key", ...}"""
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ConfigError(f"DEVICE_KEYS_JSON 不是合法 JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError("DEVICE_KEYS_JSON 必须是 {device_id: key} 对象")
    keys: dict[str, str] = {}
    for device_id, key in data.items():
        device_id, key = str(device_id).strip(), str(key).strip()
        if not device_id or not key:
            raise ConfigError("DEVICE_KEYS_JSON 中存在空的 device_id 或密钥")
        if key in keys.values():
            raise ConfigError("DEVICE_KEYS_JSON 中存在重复的密钥值")
        keys[device_id] = key
    return keys


@dataclass(frozen=True)
class Settings:
    api_key: str
    access_token: str
    database_path: Path
    frontend_dir: Path
    max_records_per_push: int
    device_keys: dict[str, str] = field(default_factory=dict)
    cors_origins: tuple[str, ...] = ()
    docs_enabled: bool = False
    max_body_bytes: int = 2 * 1024 * 1024
    allow_shared_token: bool = True  # 仅显式构造（测试）时默认放行；load_settings 会强制校验
    protocol_version: int = PROTOCOL_VERSION
    tm_ingest_secret: str = ""  # token-monitor 接入密钥（TOKEN_MONITOR_SECRET），空 = 停用
    tm_core_url: str = "http://127.0.0.1:17321"  # vendored 官方 Node hub 地址


def load_settings() -> Settings:
    api_key = os.environ.get("API_KEY", "")
    validate_secret("API_KEY", api_key)

    access_token = (os.environ.get("ACCESS_TOKEN") or "").strip()
    allow_shared = _env_bool(os.environ.get("ALLOW_SHARED_TOKEN"))
    if not access_token and not allow_shared:
        raise ConfigError(
            "ACCESS_TOKEN 未配置：只读密钥必须与写入密钥 API_KEY 分离。"
            "如确需共用，请显式设置 ALLOW_SHARED_TOKEN=true"
        )
    if not access_token:
        access_token = api_key

    raw_db = os.environ.get("DATABASE_PATH")
    database_path = Path(raw_db).expanduser() if raw_db else _default_database_path()
    if not database_path.is_absolute():
        database_path = (_project_root() / database_path).resolve()

    raw_frontend = os.environ.get("FRONTEND_DIR")
    frontend_dir = (
        Path(raw_frontend).expanduser().resolve()
        if raw_frontend
        else _default_frontend_dir()
    )

    try:
        max_records = int(os.environ.get("MAX_RECORDS_PER_PUSH", "500"))
    except ValueError:
        max_records = 500

    cors_raw = (os.environ.get("CORS_ORIGINS") or "").strip()
    cors_origins = tuple(
        origin.strip() for origin in cors_raw.split(",") if origin.strip()
    )

    try:
        max_body = int(os.environ.get("MAX_BODY_BYTES", str(2 * 1024 * 1024)))
    except ValueError:
        max_body = 2 * 1024 * 1024

    device_keys = parse_device_keys(os.environ.get("DEVICE_KEYS_JSON"))
    for device_id, key in device_keys.items():
        validate_secret(f"DEVICE_KEYS_JSON[{device_id}]", key)

    tm_secret = (os.environ.get("TOKEN_MONITOR_SECRET") or "").strip()
    if tm_secret:
        validate_secret("TOKEN_MONITOR_SECRET", tm_secret)

    # 密钥互斥：不同用途的密钥不得相等（API_KEY/ACCESS_TOKEN 仅在显式
    # ALLOW_SHARED_TOKEN 时允许共用）
    distinct: list[tuple[str, str]] = [
        ("API_KEY", api_key),
        ("TOKEN_MONITOR_SECRET", tm_secret),
        *[(f"DEVICE_KEYS_JSON[{d}]", k) for d, k in device_keys.items()],
    ]
    if access_token != api_key or not allow_shared:
        distinct.append(("ACCESS_TOKEN", access_token))
    for i, (name_a, value_a) in enumerate(distinct):
        for name_b, value_b in distinct[i + 1 :]:
            if value_a and value_b and value_a == value_b:
                raise ConfigError(
                    f"密钥 {name_a} 与 {name_b} 相同：不同用途必须使用不同密钥"
                )

    return Settings(
        api_key=api_key,
        access_token=access_token,
        database_path=database_path,
        frontend_dir=frontend_dir,
        max_records_per_push=max(1, min(max_records, 500)),
        device_keys=device_keys,
        cors_origins=cors_origins,
        docs_enabled=_env_bool(os.environ.get("DOCS_ENABLED")),
        max_body_bytes=max_body,
        allow_shared_token=allow_shared,
        protocol_version=PROTOCOL_VERSION,
        tm_ingest_secret=tm_secret,
        tm_core_url=(os.environ.get("TM_CORE_URL") or "http://127.0.0.1:17321").strip(),
    )
