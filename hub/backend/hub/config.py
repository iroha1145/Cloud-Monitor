from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

WEAK_SECRETS = {"changeme", "please-change-me", "password", "secret", "123456"}
MIN_SECRET_LENGTH = 32
TENANT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
TENANT_ROLES = ("user", "admin")


class ConfigError(Exception):
    """环境配置非法，应用必须拒绝启动。"""


@dataclass(frozen=True)
class TenantConfig:
    tenant_id: str
    tm_secret: str
    access_token: str
    role: str = "user"


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_frontend_dir() -> Path:
    # 面板目录与 backend/ 同级：hub/frontend
    return _project_root() / "hub" / "frontend"


def _default_database_path() -> Path:
    return _project_root() / "data" / "cloud-monitor.sqlite3"


def _env_bool(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


def validate_secret(name: str, value: str) -> None:
    if not value:
        raise ConfigError(f"{name} 未配置")
    if value in WEAK_SECRETS:
        raise ConfigError(f"{name} 是弱默认值，请更换为强随机值")
    if len(value) < MIN_SECRET_LENGTH:
        raise ConfigError(
            f"{name} 长度不足（最少 {MIN_SECRET_LENGTH} 个随机字符，"
            "建议 `openssl rand -hex 32`）"
        )


def parse_tenants(raw: str | None) -> dict[str, TenantConfig]:
    """解析 TENANTS_JSON：{"alice": {"tm_secret": "...", "access_token": "...", "role": "user"}}"""
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ConfigError(f"TENANTS_JSON 不是合法 JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError("TENANTS_JSON 必须是 {tenant_id: {...}} 对象")
    tenants: dict[str, TenantConfig] = {}
    for raw_id, entry in data.items():
        tenant_id = str(raw_id).strip()
        if not TENANT_ID_RE.match(tenant_id) or tenant_id == "default":
            raise ConfigError(
                f"TENANTS_JSON 租户 ID {tenant_id!r} 非法（仅允许 1-64 位字母数字/_/-，且不能为 default）"
            )
        if not isinstance(entry, dict):
            raise ConfigError(f"TENANTS_JSON[{tenant_id}] 必须是对象")
        tm_secret = str(entry.get("tm_secret") or "").strip()
        access_token = str(entry.get("access_token") or "").strip()
        role = str(entry.get("role") or "user").strip().lower()
        if role not in TENANT_ROLES:
            raise ConfigError(
                f"TENANTS_JSON[{tenant_id}].role 非法（仅允许 'user' 或 'admin'）"
            )
        validate_secret(f"TENANTS_JSON[{tenant_id}].tm_secret", tm_secret)
        validate_secret(f"TENANTS_JSON[{tenant_id}].access_token", access_token)
        tenants[tenant_id] = TenantConfig(
            tenant_id=tenant_id,
            tm_secret=tm_secret,
            access_token=access_token,
            role=role,
        )
    return tenants


@dataclass(frozen=True)
class Settings:
    access_token: str
    database_path: Path
    frontend_dir: Path
    tenants: dict[str, TenantConfig] = field(default_factory=dict)
    cors_origins: tuple[str, ...] = ()
    docs_enabled: bool = False
    tm_ingest_secret: str = ""  # token-monitor 接入密钥（TOKEN_MONITOR_SECRET），空 = 停用
    tm_core_url: str = "http://127.0.0.1:17321"  # vendored 官方 Node hub 地址
    dashboard_time_zone: str = "Asia/Tokyo"  # 未提供客户端时区时的回退（DASHBOARD_TIME_ZONE）
    tm_outbox_max_pending: int = 1000  # 快照发件箱 pending 上限（背压阈值）
    tm_background_enabled: bool = True  # 后台重放/回填线程（测试可关）
    provider_status_enabled: bool = True
    provider_status_cache_seconds: int = 300
    provider_status_timeout_seconds: float = 2.5
    overview_cache_seconds: int = 30  # overview 响应缓存 TTL（0=禁用）
    tm_background_interval: int = 300  # 后台维护循环间隔秒（outbox 重放等）
    cm_demo: bool = False  # true 时 / 返回演示页（假数据）
    serve_demo_route: bool = False  # 测试夹具：额外开放 GET /demo
    cm_version: str = "dev"
    cm_git_sha: str = ""
    cm_github_repo: str = "iroha1145/Cloud-Monitor"
    cm_update_dir: Path | None = None
    cm_update_runtime_dir: Path | None = None
    github_api_token: str = ""


def _int_env(name: str, default: int, *, minimum: int = 1, maximum: int | None = None) -> int:
    try:
        value = max(int(os.environ.get(name) or default), minimum)
    except ValueError:
        value = default
    if maximum is not None:
        value = min(value, maximum)
    return value


def _float_env(
    name: str,
    default: float,
    *,
    minimum: float = 0.1,
    maximum: float | None = None,
) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw not in (None, "") else default
    except ValueError:
        value = default
    value = max(value, minimum)
    if maximum is not None:
        value = min(value, maximum)
    return value


def load_settings() -> Settings:
    access_token = (os.environ.get("ACCESS_TOKEN") or "").strip()
    validate_secret("ACCESS_TOKEN", access_token)

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

    cors_raw = (os.environ.get("CORS_ORIGINS") or "").strip()
    cors_origins = tuple(
        origin.strip() for origin in cors_raw.split(",") if origin.strip()
    )

    dashboard_tz = (os.environ.get("DASHBOARD_TIME_ZONE") or "Asia/Tokyo").strip()
    try:
        ZoneInfo(dashboard_tz)
    except (KeyError, ValueError, OSError) as exc:  # 区域名如 Asia 是目录：IsADirectoryError
        raise ConfigError(f"DASHBOARD_TIME_ZONE 非法 IANA 时区: {dashboard_tz!r}") from exc

    tenants = parse_tenants(os.environ.get("TENANTS_JSON"))

    tm_secret = (os.environ.get("TOKEN_MONITOR_SECRET") or "").strip()
    if tm_secret:
        validate_secret("TOKEN_MONITOR_SECRET", tm_secret)

    # 面板、采集以及各租户的密钥相互独立，禁止跨用途复用。
    distinct: list[tuple[str, str]] = [
        ("ACCESS_TOKEN", access_token),
        ("TOKEN_MONITOR_SECRET", tm_secret),
    ]
    for tid, tenant in tenants.items():
        distinct.append((f"TENANTS_JSON[{tid}].tm_secret", tenant.tm_secret))
        distinct.append((f"TENANTS_JSON[{tid}].access_token", tenant.access_token))
    for i, (name_a, value_a) in enumerate(distinct):
        for name_b, value_b in distinct[i + 1 :]:
            if value_a and value_b and value_a == value_b:
                raise ConfigError(
                    f"密钥 {name_a} 与 {name_b} 相同：不同用途必须使用不同密钥"
                )

    return Settings(
        access_token=access_token,
        database_path=database_path,
        frontend_dir=frontend_dir,
        tenants=tenants,
        cors_origins=cors_origins,
        docs_enabled=_env_bool(os.environ.get("DOCS_ENABLED")),
        tm_ingest_secret=tm_secret,
        tm_core_url=(os.environ.get("TM_CORE_URL") or "http://127.0.0.1:17321").strip(),
        dashboard_time_zone=dashboard_tz,
        tm_outbox_max_pending=_int_env("TM_OUTBOX_MAX_PENDING", 1000),
        tm_background_enabled=_env_bool(os.environ.get("TM_BACKGROUND_ENABLED", "true")),
        provider_status_enabled=_env_bool(
            os.environ.get("PROVIDER_STATUS_ENABLED", "true")
        ),
        provider_status_cache_seconds=_int_env(
            "PROVIDER_STATUS_CACHE_SECONDS", 300, minimum=0, maximum=86400
        ),
        provider_status_timeout_seconds=_float_env(
            "PROVIDER_STATUS_TIMEOUT_SECONDS", 2.5, minimum=0.1, maximum=3.0
        ),
        overview_cache_seconds=_int_env(
            "OVERVIEW_CACHE_SECONDS", 30, minimum=0, maximum=300
        ),
        tm_background_interval=_int_env(
            "TM_BACKGROUND_INTERVAL", 300, minimum=10, maximum=3600
        ),
        cm_demo=_env_bool(os.environ.get("CM_DEMO")),
        serve_demo_route=_env_bool(os.environ.get("CM_SERVE_DEMO")),
        cm_version=(os.environ.get("CM_VERSION") or _file_version()).strip() or "dev",
        cm_git_sha=(os.environ.get("CM_GIT_SHA") or "").strip(),
        cm_github_repo=_github_repo_env(),
        cm_update_dir=_update_dir_env(),
        cm_update_runtime_dir=_update_runtime_dir_env(),
        github_api_token=(os.environ.get("GITHUB_TOKEN") or "").strip(),
    )

def _file_version() -> str:
    for candidate in (Path("/app/VERSION"), _project_root() / "VERSION"):
        try:
            if candidate.is_file():
                line = candidate.read_text(encoding="utf-8").strip().splitlines()[0]
                return line.strip()
        except OSError:
            continue
    return ""


def _github_repo_env() -> str:
    raw = (os.environ.get("CM_GITHUB_REPO") or "iroha1145/Cloud-Monitor").strip()
    parts = raw.split("/")
    if (
        len(parts) != 2
        or not parts[0]
        or not parts[1]
        or any(not p.replace(".", "").replace("-", "").replace("_", "").isalnum() for p in parts)
    ):
        raise ConfigError("CM_GITHUB_REPO 必须是 owner/name")
    return raw


def _update_dir_env() -> Path | None:
    raw = (os.environ.get("CM_UPDATE_DIR") or "/update").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


def _update_runtime_dir_env() -> Path | None:
    raw = (os.environ.get("CM_UPDATE_RUNTIME_DIR") or "/update-runtime").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None
