"""本机同步代理 v2：把本地 openwebui-monitor 的数据可靠地同步到云端 hub。

相对 v1 的关键变化:
- 设备身份: DEVICE_ID 环境变量优先；否则首次生成 UUID 并持久化到状态文件，
  容器重建后身份不变，绝不依赖容器 hostname。
- 数据源实例: 通过本地 /api/v1/sync/meta 获取 source_instance_id（新接口，
  id 游标同步）；旧版 monitor 自动回退到时间窗口模式并给出一次性性能警告。
- 每批推送后立即推进游标并落盘，云端故障只重推未确认的批次。
- 严格校验云端响应（received/inserted+duplicates+conflicts 守恒、conflicts=0），
  校验失败不推进游标。
- 临时错误(429/5xx/网络)指数退避重试；永久错误(400/401/403/404)进入降级模式，
  拉长间隔并写入健康状态，供 Docker 健康检查判定。
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import shutil
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

AGENT_VERSION = "cloud-monitor-agent/2.0.0"
STATE_SCHEMA_VERSION = 2
PROTOCOL_VERSION = 2
MAX_POST_ATTEMPTS = 3
DEGRADED_INTERVAL_MULTIPLIER = 10
# 与云端 hub/backend/hub/models.py 的 MAX_FUTURE_SKEW / MAX_INT 保持一致
MAX_FUTURE_SKEW = timedelta(hours=48)
MAX_RECORD_INT = 2**53 - 1
USER_CHUNK = 500
OFFICIAL_SYNC_INTERVALS = (600.0, 1200.0, 1800.0)
BUSY_TIMEOUT_OVERLAP_SECONDS = 10
# created_at 缺失时的确定性兜底：指纹按内容（含 created_at）计算，同一
# local_id 每次序列化必须逐字节一致——用墙钟时间兜底会让「已入库但响应
# 丢失」的重推变成 conflict，游标从此永久卡死
CREATED_AT_FALLBACK = "1970-01-01T00:00:00+00:00"

log = logging.getLogger("sync-agent")


class PermanentConfigError(Exception):
    """4xx 配置/协议错误：重试无意义，进入降级模式。"""


class TransientError(Exception):
    """网络 / 429 / 5xx：可安全重试。"""


class StateCorruptError(Exception):
    """状态文件损坏或 schema 不符：必须显式处理，不许静默重置身份。"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _iso_shift_seconds(value: str, seconds: int) -> str:
    """ISO 时间字符串平移 N 秒（解析失败时原样返回，不阻塞同步）。"""
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt + timedelta(seconds=seconds)).isoformat()


# ---------------------------------------------------------------- 配置


def _env_bool(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


def parse_health_stale_seconds(raw: str | None) -> float:
    """HEALTH_STALE_SECONDS 统一解析：非法回退 3600、下限 60。

    load_config 与 healthcheck.py 共用，两侧阈值口径不一致会让容器
    在 agent 明明健康时被判 unhealthy（或反之）。
    """
    try:
        return max(float(str(raw or "").strip() or 3600.0), 60.0)
    except ValueError:
        return 3600.0


LOCAL_HTTP_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal", "0.0.0.0"}


def assert_https_allowed(url: str, *, allow_insecure: bool, what: str) -> None:
    """公网地址必须 HTTPS；仅本机/容器内部地址或显式放行时允许 HTTP。"""
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return
    if parsed.scheme != "http":
        raise SystemExit(f"{what} 不是合法的 HTTP(S) 地址: {url}")
    host = (parsed.hostname or "").lower()
    if allow_insecure or host in LOCAL_HTTP_HOSTS or host.endswith(".local"):
        return
    raise SystemExit(
        f"{what} 使用了明文 HTTP 公网地址 ({url})。请改用 HTTPS，"
        "或显式设置 ALLOW_INSECURE_HTTP=true 确认风险"
    )


@dataclass(frozen=True)
class AgentConfig:
    local_monitor_url: str
    local_api_key: str
    cloud_hub_url: str
    cloud_api_key: str
    device_id: str
    device_name: str
    host_platform: str
    source_instance_id: str
    sync_interval_seconds: float
    degraded_interval_seconds: float
    batch_size: int
    state_path: Path
    request_timeout_seconds: float
    run_once: bool = False
    allow_insecure_http: bool = False
    health_stale_seconds: float = 3600.0
    time_zone: str = "Asia/Tokyo"
    token_monitor_hub_url: str = ""
    token_monitor_secret: str = ""
    token_monitor_device_id: str = ""
    token_monitor_interval_seconds: float = 300.0
    allow_legacy_fallback: bool = False
    allow_state_conflict: bool = False
    reset_cursor: bool = False
    extra: dict = field(default_factory=dict)


def load_config(env: Optional[dict[str, str]] = None) -> AgentConfig:
    env = dict(os.environ if env is None else env)

    def get(name: str, default: str = "") -> str:
        return str(env.get(name, default)).strip()

    def _float(name: str, default: float, *, minimum: float = 0.0) -> float:
        try:
            return max(float(get(name) or default), minimum)
        except ValueError:
            return default

    def _int(name: str, default: int, lo: int, hi: int) -> int:
        try:
            return min(max(int(get(name) or default), lo), hi)
        except ValueError:
            return default

    hub_url = get("CLOUD_HUB_URL")
    if not hub_url:
        raise SystemExit("缺少 CLOUD_HUB_URL（云端 hub 地址，如 https://monitor.example.com）")

    allow_insecure = _env_bool(env.get("ALLOW_INSECURE_HTTP"))
    assert_https_allowed(hub_url, allow_insecure=allow_insecure, what="CLOUD_HUB_URL")

    state_path = Path(
        get("STATE_PATH") or (Path(__file__).resolve().parent / "agent-state.json")
    ).expanduser()

    interval = _float("SYNC_INTERVAL_SECONDS", 60.0, minimum=5.0)
    tm_hub = get("TOKEN_MONITOR_HUB_URL")
    if tm_hub:
        assert_https_allowed(
            tm_hub, allow_insecure=allow_insecure, what="TOKEN_MONITOR_HUB_URL"
        )

    time_zone = get("TIME_ZONE", "Asia/Tokyo") or "Asia/Tokyo"
    try:
        ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise SystemExit(f"TIME_ZONE 非法 IANA 时区: {time_zone!r}") from exc

    return AgentConfig(
        local_monitor_url=get("LOCAL_MONITOR_URL", "http://host.docker.internal:7878").rstrip("/"),
        local_api_key=get("LOCAL_API_KEY"),
        cloud_hub_url=hub_url.rstrip("/"),
        cloud_api_key=get("CLOUD_API_KEY"),
        device_id=get("DEVICE_ID"),
        device_name=get("DEVICE_NAME"),
        host_platform=get("HOST_PLATFORM"),
        source_instance_id=get("SOURCE_INSTANCE_ID"),
        sync_interval_seconds=interval,
        degraded_interval_seconds=interval * DEGRADED_INTERVAL_MULTIPLIER,
        batch_size=_int("BATCH_SIZE", 200, 1, 500),
        state_path=state_path,
        request_timeout_seconds=_float("REQUEST_TIMEOUT_SECONDS", 15.0, minimum=1.0),
        run_once=_env_bool(env.get("RUN_ONCE")),
        allow_insecure_http=allow_insecure,
        health_stale_seconds=parse_health_stale_seconds(env.get("HEALTH_STALE_SECONDS")),
        time_zone=time_zone,
        token_monitor_hub_url=tm_hub,
        token_monitor_secret=get("TOKEN_MONITOR_SECRET"),
        token_monitor_device_id=get("TOKEN_MONITOR_DEVICE_ID"),
        token_monitor_interval_seconds=clamp_token_monitor_interval(
            _float("TOKEN_MONITOR_INTERVAL_SECONDS", 600.0, minimum=30.0)
        ),
        allow_legacy_fallback=_env_bool(env.get("ALLOW_LEGACY_FALLBACK")),
        # 独立开关：设备身份切换授权。此前从未被读取，错误提示教用户设它
        # 却接的是 ALLOW_LEGACY_FALLBACK——两者语义无关，不得交叉授权
        allow_state_conflict=_env_bool(env.get("ALLOW_STATE_CONFLICT")),
        reset_cursor=_env_bool(env.get("RESET_CURSOR")),
    )


# ---------------------------------------------------------------- 状态文件


class AgentState:
    """同步游标 + 设备身份 + 健康信息，原子写入，损坏时备份并拒绝静默重置。"""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = self._fresh()
        self._lock = threading.Lock()

    @staticmethod
    def _fresh() -> dict[str, Any]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "device_id": "",
            "mode": None,  # "cursor" | "time"
            "source_instance_id": "",
            "cursor": 0,
            "watermark": None,
            "pushed_records": 0,
            "last_success_at": None,
            "last_push_at": None,
            "last_error": None,
            "last_error_type": None,
            "last_permanent_error": None,
            "cursor_regressed_at": None,
            "cursor_regressed_from": None,
            "cursor_regressed_to": None,
        }

    def load(self, *, readonly: bool = False) -> None:
        if not self.path.is_file():
            return

        def backup(reason: str) -> None:
            if not readonly:
                self._backup_corrupt(reason)

        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            backup(f"无法解析: {exc}")
            raise StateCorruptError(str(exc)) from exc
        if not isinstance(loaded, dict):
            backup("顶层不是对象")
            raise StateCorruptError("state json is not an object")
        version = loaded.get("schema_version")
        if version is None:
            # v1 状态文件（无 schema_version）：识别并迁移为 v2，保留既有身份
            # 与游标（不悄悄改变设备身份）。
            if "device_id" in loaded or "watermark" in loaded or "cursor" in loaded:
                migrated = self._fresh()
                for key in ("device_id", "watermark", "cursor"):
                    if key in loaded:
                        migrated[key] = loaded[key]
                self.data = migrated
                if not readonly:
                    log.warning("检测到 v1 状态文件，已就地迁移为 schema_version=2")
                return
            backup("缺少 schema_version")
            raise StateCorruptError("missing schema_version")
        if not isinstance(version, int) or version != STATE_SCHEMA_VERSION:
            backup(f"schema_version={version!r} 不支持")
            raise StateCorruptError(f"unsupported schema_version {version!r}")
        if "device_id" in loaded and not isinstance(loaded["device_id"], str):
            backup("device_id 不是字符串")
            raise StateCorruptError("device_id must be a string")
        fresh = self._fresh()
        fresh.update(loaded)
        self.data = fresh

    def _backup_corrupt(self, reason: str) -> None:
        if not self.path.is_file():
            return
        stamp = datetime.now().strftime("%Y%m%d")
        backup = self.path.with_name(f"{self.path.name}.corrupt-{stamp}")
        if backup.exists():
            log.error("状态文件损坏（%s），当日备份已存在 %s", reason, backup)
            return
        try:
            shutil.copy2(self.path, backup)
            log.error("状态文件损坏（%s），已复制备份到 %s；原文件保留以免重启换身份", reason, backup)
        except OSError:
            log.error("状态文件损坏（%s）且备份失败: %s", reason, self.path)

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(
                f"{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            payload = json.dumps(self.data, ensure_ascii=False, indent=2)
            with tmp.open("w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)

    # 便捷访问 ------------------------------------------------------

    @property
    def device_id(self) -> str:
        return str(self.data.get("device_id") or "")

    @device_id.setter
    def device_id(self, value: str) -> None:
        self.data["device_id"] = value

    @property
    def mode(self) -> Optional[str]:
        return self.data.get("mode")

    @mode.setter
    def mode(self, value: Optional[str]) -> None:
        self.data["mode"] = value

    @property
    def source_instance_id(self) -> str:
        return str(self.data.get("source_instance_id") or "")

    @source_instance_id.setter
    def source_instance_id(self, value: str) -> None:
        self.data["source_instance_id"] = value

    @property
    def cursor(self) -> int:
        return int(self.data.get("cursor") or 0)

    @cursor.setter
    def cursor(self, value: int) -> None:
        self.data["cursor"] = int(value)

    @property
    def watermark(self) -> Optional[str]:
        return self.data.get("watermark")

    @watermark.setter
    def watermark(self, value: Optional[str]) -> None:
        self.data["watermark"] = value


def resolve_device_id(config: AgentConfig, state: AgentState) -> str:
    """身份优先级: 环境变量 > 状态文件 > 首次生成 UUID 并持久化。

    DEVICE_ID 与状态文件冲突时默认失败关闭（P1-7），防止静默切换身份；
    仅显式 ALLOW_STATE_CONFLICT=true 时以环境变量为准。
    """
    if config.device_id:
        if state.device_id and state.device_id != config.device_id:
            if not config.allow_state_conflict:
                raise SystemExit(
                    "DEVICE_ID 环境变量 (%s) 与状态文件中的身份 (%s) 不同。"
                    "为避免静默切换设备身份，agent 拒绝启动；如确需切换，"
                    "请显式设置 ALLOW_STATE_CONFLICT=true 并确认云端设备列表。"
                    % (config.device_id, state.device_id)
                )
            log.warning(
                "ALLOW_STATE_CONFLICT=true：以环境变量身份 %s 覆盖状态文件身份 %s",
                config.device_id,
                state.device_id,
            )
        return config.device_id
    if state.device_id:
        return state.device_id
    new_id = f"agent-{uuid.uuid4()}"
    log.info("首次启动，生成设备身份 %s（已持久化，重建容器不变）", new_id)
    return new_id


# ---------------------------------------------------------------- HTTP


def classify_status(status_code: int) -> bool:
    """True = 临时可重试（408/425/429/5xx），False = 永久配置错误。"""
    return status_code in (408, 425, 429) or status_code >= 500


MAX_RETRY_AFTER_SECONDS = 3600.0


def retry_after_seconds(headers: Optional[dict]) -> Optional[float]:
    """解析 Retry-After 秒数；HTTP-date / 非有限值返回 None，上限 1 小时。"""
    raw = (headers or {}).get("Retry-After")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return min(max(value, 0.5), MAX_RETRY_AFTER_SECONDS)


def _is_cert_verify_failure(exc: BaseException) -> bool:
    current: BaseException | None = exc
    seen = 0
    while current is not None and seen < 8:
        if current.__class__.__name__ == "SSLCertVerificationError":
            return True
        if "CERTIFICATE_VERIFY_FAILED" in str(current):
            return True
        current = current.__cause__ or current.__context__
        seen += 1
    return False


def clamp_token_monitor_interval(seconds: float) -> float:
    """官方 normalizeSyncUploadIntervalMs 只认 0/10/20/30 分钟，其它值归一成 0。"""
    if seconds <= 0:
        return 600.0
    return min(OFFICIAL_SYNC_INTERVALS, key=lambda allowed: abs(allowed - seconds))


def post_with_retry(
    session: requests.Session,
    url: str,
    *,
    json_body: dict,
    headers: dict,
    timeout: float,
    attempts: int = MAX_POST_ATTEMPTS,
) -> dict:
    """可安全重试的 POST：指数退避 + 随机抖动；确定性 4xx 直接判定永久错误。"""
    last_exc: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            resp = session.post(url, json=json_body, headers=headers, timeout=timeout)
        except requests.exceptions.SSLError as exc:
            if _is_cert_verify_failure(exc):
                raise PermanentConfigError(f"TLS 证书校验失败: {exc}") from exc
            last_exc = exc
            delay = (2**attempt) + random.uniform(0, 0.5)
            log.warning("TLS 握手瞬时失败（第 %d 次）: %s，%.1fs 后重试", attempt + 1, exc, delay)
            time.sleep(delay)
            continue
        except requests.RequestException as exc:
            last_exc = exc
            delay = (2**attempt) + random.uniform(0, 0.5)
            log.warning("网络错误（第 %d 次）: %s，%.1fs 后重试", attempt + 1, exc, delay)
            time.sleep(delay)
            continue
        if resp.status_code >= 400:
            detail = resp.text[:300]
            if classify_status(resp.status_code):
                delay = retry_after_seconds(resp.headers)
                if delay is None:
                    delay = (2**attempt) + random.uniform(0, 0.5)
                if attempt >= attempts - 1:
                    raise TransientError(f"HTTP {resp.status_code}: {detail}")
                log.warning(
                    "云端临时错误 %d（第 %d 次）: %s，%.1fs 后重试",
                    resp.status_code, attempt + 1, detail, delay,
                )
                time.sleep(delay)
                last_exc = TransientError(f"HTTP {resp.status_code}")
                continue
            raise PermanentConfigError(f"云端拒绝推送 HTTP {resp.status_code}: {detail}")
        try:
            return resp.json()
        except ValueError as exc:
            last_exc = TransientError(f"响应不是 JSON: {exc}")
            time.sleep(1 + random.uniform(0, 0.5))
    raise last_exc or TransientError("unknown transient failure")


def validate_push_response(
    body: Any, *, sent: int, device_id: str, source_instance_id: str
) -> dict:
    """严格校验云端响应；任何不一致都视为本轮失败（不推进游标）。"""
    if not isinstance(body, dict) or body.get("success") is not True:
        raise ValueError(f"云端响应缺少 success=true: {body!r:.200}")
    if body.get("device_id") != device_id:
        raise ValueError(
            f"云端响应 device_id 不匹配: 期望 {device_id} 实际 {body.get('device_id')!r}"
        )
    if body.get("source_instance_id") != source_instance_id:
        raise ValueError(
            f"云端响应 source_instance_id 不匹配: 期望 {source_instance_id} "
            f"实际 {body.get('source_instance_id')!r}"
        )
    received = body.get("received")
    if not isinstance(received, int) or received != sent:
        raise ValueError(f"received 应为 {sent}，实际 {received!r}")
    inserted, duplicates, conflicts = (
        body.get("inserted"), body.get("duplicates"), body.get("conflicts")
    )
    for name, value in (("inserted", inserted), ("duplicates", duplicates), ("conflicts", conflicts)):
        if not isinstance(value, int):
            raise ValueError(f"云端响应 {name} 缺失或非整数: {value!r}")
    if inserted + duplicates + conflicts != received:
        raise ValueError(
            f"守恒校验失败: inserted({inserted})+duplicates({duplicates})"
            f"+conflicts({conflicts}) != received({received})"
        )
    if conflicts > 0:
        raise ValueError(
            f"检测到 {conflicts} 条内容冲突（同一主键不同内容），"
            "请人工核查云端与本地数据，游标不推进"
        )
    return body


# ---------------------------------------------------------------- 同步主体


class SyncAgent:
    def __init__(self, config: AgentConfig, state: AgentState, session: Optional[requests.Session] = None):
        self.config = config
        self.state = state
        self.session = session or requests.Session()
        self._reset_cursor_applied = False
        self._skipped_users = 0

    # ------------------------------------------------------------ 本地读取

    def local_get(
        self,
        path: str,
        params: dict[str, Any],
        session: Optional[requests.Session] = None,
    ) -> Any:
        headers = {}
        if self.config.local_api_key:
            headers["Authorization"] = f"Bearer {self.config.local_api_key}"
        resp = (session or self.session).get(
            f"{self.config.local_monitor_url}{path}",
            params=params,
            headers=headers,
            timeout=self.config.request_timeout_seconds,
        )
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status in (401, 403):
                raise PermanentConfigError(
                    f"本地 monitor 鉴权失败 HTTP {status}（LOCAL_API_KEY？）"
                ) from exc
            raise
        try:
            body = resp.json()
        except ValueError as exc:
            raise TransientError(f"本地接口 {path} 响应不是 JSON") from exc
        if isinstance(body, str):
            raise TransientError(f"本地接口 {path} 返回了字符串而不是对象")
        return body

    def _sanitize_user(self, raw: Any) -> Optional[dict]:
        if not isinstance(raw, dict):
            self._skipped_users += 1
            log.warning("跳过无法同步的用户（不是对象）")
            return None
        user_id = raw.get("id")
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            self._skipped_users += 1
            log.warning("跳过无法同步的用户 id=%r", raw.get("id"))
            return None
        email = raw.get("email") or ""
        name = raw.get("name") or ""
        role = raw.get("role") or "user"
        if not isinstance(email, str) or not isinstance(name, str) or not isinstance(role, str):
            self._skipped_users += 1
            log.warning("跳过无法同步的用户 %s（字段类型非法）", user_id)
            return None
        created = raw.get("created_at")
        updated = raw.get("updated_at")
        if created is not None and not isinstance(created, str):
            created = None
        if updated is not None and not isinstance(updated, str):
            updated = None
        return {
            "id": user_id,
            "email": email[:254],
            "name": name[:128],
            "role": role[:32],
            "created_at": (created[:64] if isinstance(created, str) else None),
            "updated_at": (updated[:64] if isinstance(updated, str) else None),
        }

    def fetch_users(self) -> list[dict]:
        payload = self.local_get("/api/v1/users", {})
        if not isinstance(payload, dict):
            raise TransientError("本地 /api/v1/users 响应不是对象")
        self._skipped_users = 0
        users = [
            user
            for user in (self._sanitize_user(item) for item in payload.get("users") or [])
            if user
        ]
        if self._skipped_users:
            self.state.data["skipped_users"] = (
                int(self.state.data.get("skipped_users") or 0) + self._skipped_users
            )
            log.warning("本批共跳过 %d 个无法同步的用户", self._skipped_users)
        digest = hashlib.sha256(
            json.dumps(users, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        self.state.data["users_digest"] = digest
        return users

    def probe_sync_meta(self) -> Optional[dict]:
        """新版 monitor 提供 /api/v1/sync/meta。

        404（旧版 monitor）默认拒绝启动（P1-7）：时间窗口回退在数据源
        变更时会产生重复或丢数据。仅显式同时配置
        ALLOW_LEGACY_FALLBACK=true 与 SOURCE_INSTANCE_ID=<稳定值> 才允许。
        """
        try:
            return self.local_get("/api/v1/sync/meta", {})
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                if not self.config.allow_legacy_fallback or not self.config.source_instance_id:
                    raise SystemExit(
                        "本地 monitor 不支持 /api/v1/sync/meta（协议 v2 游标接口）。"
                        "请升级 openwebui-monitor；如确需旧版时间窗口回退，显式配置 "
                        "ALLOW_LEGACY_FALLBACK=true 与 SOURCE_INSTANCE_ID=<稳定值>。"
                    ) from exc
                return None
            raise

    # ------------------------------------------------------------ 云端推送

    def _push_payload(
        self, users: list[dict], records: list[dict], source_instance_id: str
    ) -> dict:
        return {
            "device": {
                "id": self.config.device_id or self.state.device_id,
                "name": self.config.device_name,
                "platform": self.config.host_platform,
                "agent_version": AGENT_VERSION,
            },
            "source_instance_id": source_instance_id,
            "users": users,
            "records": records,
        }

    def push_batch(
        self, users: list[dict], records: list[dict], source_instance_id: str
    ) -> dict:
        sent = len(records)
        combined: dict = {"received": 0, "inserted": 0, "duplicates": 0, "conflicts": 0, "users_upserted": 0}
        user_chunks = [users[i:i + USER_CHUNK] for i in range(0, len(users), USER_CHUNK)] if users else [[]]
        for index, chunk in enumerate(user_chunks):
            payload = self._push_payload(chunk, records if index == 0 else [], source_instance_id)
            try:
                body = post_with_retry(
                    self.session,
                    f"{self.config.cloud_hub_url}/api/v1/sync/push",
                    json_body=payload,
                    headers={"Authorization": f"Bearer {self.config.cloud_api_key}"},
                    timeout=self.config.request_timeout_seconds,
                )
            except PermanentConfigError as exc:
                if "单次最多" in str(exc) and records and self.config.batch_size > 1:
                    raise TransientError(f"云端单批上限小于当前批次，将缩批重试: {exc}") from exc
                raise
            device_id = payload["device"]["id"]
            result = validate_push_response(
                body,
                sent=sent if index == 0 else 0,
                device_id=device_id,
                source_instance_id=source_instance_id,
            )
            for key in combined:
                combined[key] += int(result.get(key) or 0)
        # Only complete user uploads reset the periodic refresh timer. Otherwise
        # a failed later chunk could make unchanged users look fully refreshed.
        if users:
            self.state.data["last_users_push_at"] = utc_now_iso()
        return combined

    @staticmethod
    def _record_wire(r: dict) -> dict:
        return {
            "local_id": r["id"],
            "user_id": r.get("user_id") or "",
            "nickname": r.get("nickname") or "",
            "model_name": r.get("model_name") or "",
            "input_tokens": int(r.get("input_tokens") or 0),
            "output_tokens": int(r.get("output_tokens") or 0),
            "created_at": str(r.get("created_at") or "").strip() or CREATED_AT_FALLBACK,
        }

    @staticmethod
    def _record_reject_reason(r: dict) -> Optional[str]:
        """镜像云端 RecordIn 的全部确定性拒因（400 → PermanentConfigError）。"""
        user_id = r.get("user_id") or ""
        if not isinstance(user_id, str) or not user_id:
            return "user_id 为空"
        if len(user_id) > 128:
            return "user_id 超过 128 字符"
        nickname = r.get("nickname") or ""
        if not isinstance(nickname, str) or len(nickname) > 128:
            return "nickname 超过 128 字符"
        model_name = r.get("model_name") or ""
        if not isinstance(model_name, str) or len(model_name) > 256:
            return "model_name 超过 256 字符"
        local_id = r.get("id")
        if isinstance(local_id, bool) or not isinstance(local_id, int) or local_id < 1:
            return f"local_id 不是 ≥1 的严格整数: {local_id!r}"
        if local_id > MAX_RECORD_INT:
            return "local_id 超出范围"
        for key in ("input_tokens", "output_tokens"):
            value = r.get(key) or 0
            if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_RECORD_INT:
                return f"{key} 超出范围或不是严格整数"
        created = str(r.get("created_at") or "").strip()
        if len(created) > 64:
            return "created_at 超过 64 字符"
        if created:
            raw = created.replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                dt.astimezone(timezone.utc)
            except (ValueError, OverflowError):
                return f"created_at 不是合法的 ISO 8601 时间: {created!r}"
            if dt > datetime.now(timezone.utc) + MAX_FUTURE_SKEW:
                return f"created_at 超前当前时间过多: {created}"
        return None

    def _classify_records(self, records: list[dict]) -> tuple[list[dict], int]:
        """拆分可同步/必被云端拒绝的记录；不写状态（等推送成功后再计数）。"""
        wire: list[dict] = []
        skipped = 0
        for r in records:
            reason = self._record_reject_reason(r)
            if reason is None:
                wire.append(self._record_wire(r))
                continue
            skipped += 1
            if skipped <= 5:
                log.warning("跳过无法同步的记录 local_id=%s（%s）", r.get("id"), reason)
        if skipped > 5:
            log.warning("本批共跳过 %d 条无法同步的记录", skipped)
        return wire, skipped

    def _wire_valid(self, records: list[dict]) -> tuple[list[dict], int]:
        wire, skipped = self._classify_records(records)
        if skipped:
            self.state.data["skipped_invalid"] = (
                int(self.state.data.get("skipped_invalid") or 0) + skipped
            )
        return wire, skipped

    # ------------------------------------------------------------ 同步轮次

    def _resolve_source(self, meta: Optional[dict]) -> tuple[str, str, Optional[int]]:
        """返回 (mode, source_instance_id, snapshot_max_id)。处理实例轮换。

        meta 可用时以 meta 的实例 ID 为准：固定的 SOURCE_INSTANCE_ID 会掩盖
        本地库重建（id 从 1 重新计数），游标停在旧高位、永远读 0 条且心跳
        照常成功——静默永久丢数据。pin 值仅作 meta 缺失（legacy 回退）时的来源。
        """
        if isinstance(meta, dict):
            live = str(meta.get("source_instance_id") or "")
            if meta.get("max_record_id") is None:
                # 缺字段或显式 null 时按 0 处理会让 records 接口（id <= snapshot_max_id）
                # 永远返回 0 条而心跳照常成功——静默停摆比显式失败更危险
                raise PermanentConfigError(
                    "/api/v1/sync/meta 缺少 max_record_id 字段（本地 monitor 版本过旧？）"
                )
            snapshot = int(meta.get("max_record_id") or 0)
            pinned = self.config.source_instance_id
            if pinned and live and live != pinned:
                log.warning(
                    "SOURCE_INSTANCE_ID=%s 与本地 monitor 实际实例 %s 不一致，"
                    "以实际实例为准（否则库重建后游标空转、数据静默不再同步）。"
                    "meta 接口可用时建议移除 SOURCE_INSTANCE_ID 配置",
                    pinned,
                    live,
                )
            return "cursor", live or pinned, snapshot
        if meta is not None:
            raise PermanentConfigError(
                f"/api/v1/sync/meta 响应不是对象（得到 {type(meta).__name__}）"
            )

        if not self.config.source_instance_id:
            # probe_sync_meta 已保证：无 meta 且未配置回退时早已 SystemExit
            raise PermanentConfigError(
                "本地 monitor 无 /api/v1/sync/meta 且未配置 SOURCE_INSTANCE_ID"
            )
        if self.state.mode != "time":
            log.warning(
                "本地 monitor 不支持 /api/v1/sync/meta，回退时间窗口分页模式；"
                "全量同步时本地会重复扫描历史数据，建议升级 openwebui-monitor"
            )
        return "time", self.config.source_instance_id, None

    def _rotate_if_needed(self, mode: str, source: str) -> bool:
        """数据源实例变化（本地库重建）→ 重置游标走全量，避免 local_id 复用被吞。"""
        if self.state.source_instance_id and self.state.source_instance_id != source:
            log.warning(
                "检测到本地数据源实例变化 %s → %s（本地数据库重建？），"
                "重置游标并全量同步到新的 source_instance_id",
                self.state.source_instance_id,
                source,
            )
            self.state.cursor = 0
            self.state.watermark = None
            self.state.save()
        changed = (
            self.state.mode != mode or self.state.source_instance_id != source
        )
        self.state.mode = mode
        self.state.source_instance_id = source
        return changed

    def run_once(self) -> dict:
        meta = self.probe_sync_meta()
        mode, source, snapshot_max = self._resolve_source(meta)
        self._rotate_if_needed(mode, source)

        if mode == "cursor":
            return self._run_cursor_round(source, snapshot_max or 0)
        return self._run_time_round(source)

    def _run_cursor_round(self, source: str, snapshot_max_id: int) -> dict:
        if self.config.reset_cursor and not self._reset_cursor_applied:
            self.state.cursor = 0
            self.state.data["cursor_regressed_at"] = None
            self.state.data["cursor_regressed_from"] = None
            self.state.data["cursor_regressed_to"] = None
            self.state.save()
            self._reset_cursor_applied = True
            log.warning("RESET_CURSOR=true：已清游标并解除回退锁存，将全量重推")
        if self.state.data.get("cursor_regressed_at") and not self.config.reset_cursor:
            raise PermanentConfigError(
                f"本地库回退已锁存：cursor 曾从 {self.state.data.get('cursor_regressed_from')} "
                f"落到 {self.state.data.get('cursor_regressed_to')}。"
                "设置 RESET_CURSOR=true 后才会归零全量重推。"
            )
        if snapshot_max_id < int(self.state.cursor or 0):
            self.state.data["cursor_regressed_at"] = utc_now_iso()
            self.state.data["cursor_regressed_from"] = int(self.state.cursor or 0)
            self.state.data["cursor_regressed_to"] = int(snapshot_max_id)
            self.state.save()
            raise PermanentConfigError(
                f"本地库回退：max_record_id={snapshot_max_id} < cursor={self.state.cursor}。"
                "已锁存；请检查备份恢复或显式设置 RESET_CURSOR=true 后全量重推。"
            )
        users = self.fetch_users()
        send_users = self._users_for_push(users)
        fetched = 0
        inserted = 0
        first_batch = True
        limit = int(self.state.data.get("effective_batch_size") or self.config.batch_size)
        limit = min(max(limit, 1), self.config.batch_size)
        while True:
            after_id = self.state.cursor
            payload = self.local_get(
                "/api/v1/sync/records",
                {
                    "after_id": after_id,
                    "snapshot_max_id": snapshot_max_id,
                    "limit": limit,
                },
            )
            if not isinstance(payload, dict):
                raise TransientError("本地 /api/v1/sync/records 响应不是对象")
            records = payload.get("records") or []
            if not isinstance(records, list):
                raise TransientError("本地 records 字段不是数组")
            if not records:
                if first_batch:
                    result = self.push_batch(send_users, [], source)
                    self._mark_batch_ok(users_digest=self.state.data.get("users_digest"))
                    log.info(
                        "心跳完成: users=%d received=%d", result.get("users_upserted", 0), 0
                    )
                break
            wire_records, skipped = self._classify_records(records)
            try:
                result = self.push_batch(send_users if first_batch else [], wire_records, source)
            except TransientError as exc:
                if "缩批" in str(exc) and limit > 1:
                    limit = max(1, limit // 2)
                    self.state.data["effective_batch_size"] = limit
                    log.warning("按云端上限将 BATCH_SIZE 降为 %d 后重试本批", limit)
                    continue
                raise
            fetched += len(records)
            if skipped:
                self.state.data["skipped_invalid"] = (
                    int(self.state.data.get("skipped_invalid") or 0) + skipped
                )
            inserted += int(result.get("inserted") or 0)
            try:
                self.state.cursor = int(records[-1]["id"])
            except (KeyError, TypeError, ValueError) as exc:
                raise TransientError(f"记录 id 不是可推进的数字: {records[-1].get('id')!r}") from exc
            self.state.data["pushed_records"] += int(result.get("inserted") or 0)
            self.state.data["effective_batch_size"] = limit
            self._mark_batch_ok(users_digest=self.state.data.get("users_digest"))
            first_batch = False
            if len(records) < limit:
                break
        return {"mode": "cursor", "fetched": fetched, "inserted": inserted}

    def _users_for_push(self, users: list[dict]) -> list[dict]:
        previous_digest = self.state.data.get("last_users_digest")
        last_push = self.state.data.get("last_users_push_at")
        if last_push:
            try:
                dt = datetime.fromisoformat(str(last_push).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if (datetime.now(timezone.utc) - dt).total_seconds() >= 6 * 3600:
                    return users
            except ValueError:
                return users
        return users if self.state.data.get("users_digest") != previous_digest else []

    def _mark_batch_ok(self, *, users_digest: Optional[str] = None) -> None:
        self.state.data["last_batch_ok_at"] = utc_now_iso()
        if users_digest:
            self.state.data["last_users_digest"] = users_digest
        self.state.save()

    @staticmethod
    def _record_sort_key(r: dict) -> tuple[str, int]:
        created = str(r.get("created_at") or "")
        try:
            rid = int(r.get("id") or 0)
        except (TypeError, ValueError):
            rid = 0
        return (created, rid)

    def _run_time_round(self, source: str) -> dict:
        snapshot_end = utc_now_iso()
        watermark = self.state.watermark
        users = self.fetch_users()
        send_users = self._users_for_push(users)

        records: list[dict] = []
        page = 1
        while True:
            params: dict[str, Any] = {"end_time": snapshot_end, "page": page, "page_size": 200}
            if watermark:
                # 水位线前移 busy_timeout 重叠：锁等待或时钟回拨导致 stamp
                # 早于水位线的迟到记录不得丢失；重复由云端幂等去重
                params["start_time"] = _iso_shift_seconds(watermark, -BUSY_TIMEOUT_OVERLAP_SECONDS)
            payload = self.local_get("/api/v1/records", params)
            batch = payload.get("records") or []
            records.extend(batch)
            total = int(payload.get("total") or 0)
            if not batch or len(records) >= total:
                break
            page += 1

        records.sort(key=self._record_sort_key)
        if not records:
            result = self.push_batch(send_users, [], source)
            self._mark_batch_ok(users_digest=self.state.data.get("users_digest"))
            log.info(
                "心跳完成: users=%d", result.get("users_upserted", 0)
            )
            return {"mode": "time", "fetched": 0, "inserted": 0}

        fetched = len(records)
        inserted = 0
        offset = 0
        first_batch = True
        limit = int(self.state.data.get("effective_batch_size") or self.config.batch_size)
        limit = min(max(limit, 1), self.config.batch_size)
        while offset < fetched:
            chunk = records[offset : offset + limit]
            wire_records, skipped = self._classify_records(chunk)
            try:
                result = self.push_batch(send_users if first_batch else [], wire_records, source)
            except TransientError as exc:
                if "缩批" in str(exc) and limit > 1:
                    limit = max(1, limit // 2)
                    self.state.data["effective_batch_size"] = limit
                    log.warning("按云端上限将 BATCH_SIZE 降为 %d 后重试本批", limit)
                    continue
                raise
            if skipped:
                self.state.data["skipped_invalid"] = (
                    int(self.state.data.get("skipped_invalid") or 0) + skipped
                )
            inserted += int(result.get("inserted") or 0)
            self.state.data["effective_batch_size"] = limit
            self.state.watermark = chunk[-1].get("created_at") or snapshot_end
            self.state.data["pushed_records"] += int(result.get("inserted") or 0)
            self._mark_batch_ok(users_digest=self.state.data.get("users_digest"))
            offset += len(chunk)
            first_batch = False
        return {"mode": "time", "fetched": fetched, "inserted": inserted}

    # ------------------------------------------------------------ 主循环

    def run_forever(self) -> None:
        device_id = self.config.device_id or self.state.device_id
        stop = {"flag": False}

        def _stop(_signum=None, _frame=None) -> None:
            stop["flag"] = True

        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
        log.info(
            "启动 agent v2: device=%s 本地=%s → 云端=%s 间隔=%ss",
            device_id,
            self.config.local_monitor_url,
            self.config.cloud_hub_url,
            self.config.sync_interval_seconds,
        )
        while not stop["flag"]:
            interval = self.config.sync_interval_seconds
            try:
                summary = self.run_once()
                self.state.data["last_success_at"] = utc_now_iso()
                self.state.data["last_error"] = None
                self.state.data["last_error_type"] = None
                self.state.data["last_permanent_error"] = None
                self.state.data["last_push_at"] = utc_now_iso()
                self.state.save()
                log.info("同步完成: %s", summary)
            except PermanentConfigError as exc:
                interval = self.config.degraded_interval_seconds
                self._record_error("permanent", str(exc))
                log.error(
                    "永久配置错误，%.0fs 后再试（降级模式）: %s", interval, exc
                )
                if self.config.run_once:
                    # RUN_ONCE 撞永久错误（401 等）必须非零退出：
                    # cron/CI 的一次性调用不得把配置错误报告成成功
                    raise SystemExit(4) from exc
            except (TransientError, requests.RequestException, ValueError) as exc:
                self._record_error("transient", str(exc))
                log.error("本轮同步失败，下个周期重试: %s", exc)
                if self.config.run_once:
                    raise SystemExit(3) from exc
            if self.config.run_once:
                break
            deadline = time.monotonic() + interval
            while not stop["flag"] and time.monotonic() < deadline:
                time.sleep(min(1.0, deadline - time.monotonic()))

    def _record_error(self, kind: str, message: str) -> None:
        self.state.data["last_error"] = message
        self.state.data["last_error_type"] = kind
        self.state.data["last_error_at"] = utc_now_iso()
        if kind == "permanent":
            self.state.data["last_permanent_error"] = message
        self.state.save()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    try:
        config = load_config()
    except SystemExit as exc:
        log.error("%s", exc)
        return 1
    state = AgentState(config.state_path)
    try:
        state.load()
    except StateCorruptError:
        if not config.device_id:
            log.error(
                "状态文件损坏且未显式配置 DEVICE_ID；为避免静默改变设备身份，"
                "agent 拒绝启动。请设置 DEVICE_ID 环境变量（或删除云端旧设备数据后"
                "以新身份重新全量同步）"
            )
            return 2
        log.warning("状态文件损坏，但 DEVICE_ID 已显式配置，以环境变量身份继续")
        state = AgentState(config.state_path)

    try:
        state.device_id = resolve_device_id(config, state)
    except SystemExit as exc:
        log.error("%s", exc)
        return 1
    state.save()

    agent = SyncAgent(config, state)
    try:
        from token_monitor_bridge import start_bridge_thread

        start_bridge_thread(agent)
    except ImportError as exc:
        log.warning("token-monitor 桥接模块不可用: %s", exc)
    except Exception as exc:  # noqa: BLE001 — 可选桥接不得拖垮主同步
        log.exception("token-monitor 桥接未启动（不影响主同步）: %s", exc)
    agent.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
