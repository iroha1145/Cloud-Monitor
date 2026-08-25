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

import json
import logging
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import requests

AGENT_VERSION = "cloud-monitor-agent/2.0.0"
STATE_SCHEMA_VERSION = 2
PROTOCOL_VERSION = 2
MAX_POST_ATTEMPTS = 3
DEGRADED_INTERVAL_MULTIPLIER = 10
# 与云端 hub/backend/hub/models.py 的 MAX_FUTURE_SKEW 保持一致
MAX_FUTURE_SKEW = timedelta(hours=48)

log = logging.getLogger("sync-agent")


class PermanentConfigError(Exception):
    """4xx 配置/协议错误：重试无意义，进入降级模式。"""


class TransientError(Exception):
    """网络 / 429 / 5xx：可安全重试。"""


class StateCorruptError(Exception):
    """状态文件损坏或 schema 不符：必须显式处理，不许静默重置身份。"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- 配置


def _env_bool(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


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
        run_once=get("RUN_ONCE") in ("1", "true", "yes"),
        allow_insecure_http=allow_insecure,
        health_stale_seconds=_float("HEALTH_STALE_SECONDS", 3600.0, minimum=60.0),
        time_zone=get("TIME_ZONE", "Asia/Tokyo"),
        token_monitor_hub_url=tm_hub,
        token_monitor_secret=get("TOKEN_MONITOR_SECRET"),
        token_monitor_device_id=get("TOKEN_MONITOR_DEVICE_ID"),
        token_monitor_interval_seconds=_float("TOKEN_MONITOR_INTERVAL_SECONDS", 300.0, minimum=30.0),
        allow_legacy_fallback=_env_bool(env.get("ALLOW_LEGACY_FALLBACK")),
        # 独立开关：设备身份切换授权。此前从未被读取，错误提示教用户设它
        # 却接的是 ALLOW_LEGACY_FALLBACK——两者语义无关，不得交叉授权
        allow_state_conflict=_env_bool(env.get("ALLOW_STATE_CONFLICT")),
    )


# ---------------------------------------------------------------- 状态文件


class AgentState:
    """同步游标 + 设备身份 + 健康信息，原子写入，损坏时备份并拒绝静默重置。"""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = self._fresh()

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
        }

    def load(self) -> None:
        if not self.path.is_file():
            return
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self._backup_corrupt(f"无法解析: {exc}")
            raise StateCorruptError(str(exc)) from exc
        if not isinstance(loaded, dict):
            self._backup_corrupt("顶层不是对象")
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
                log.warning("检测到 v1 状态文件，已就地迁移为 schema_version=2")
                return
            self._backup_corrupt("缺少 schema_version")
            raise StateCorruptError("missing schema_version")
        if not isinstance(version, int) or version != STATE_SCHEMA_VERSION:
            self._backup_corrupt(f"schema_version={version!r} 不支持")
            raise StateCorruptError(f"unsupported schema_version {version!r}")
        if "device_id" in loaded and not isinstance(loaded["device_id"], str):
            self._backup_corrupt("device_id 不是字符串")
            raise StateCorruptError("device_id must be a string")
        fresh = self._fresh()
        fresh.update(loaded)
        self.data = fresh

    def _backup_corrupt(self, reason: str) -> None:
        if not self.path.is_file():
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = self.path.with_name(f"{self.path.name}.corrupt-{stamp}")
        try:
            self.path.replace(backup)
            log.error("状态文件损坏（%s），已备份到 %s", reason, backup)
        except OSError:
            log.error("状态文件损坏（%s）且备份失败: %s", reason, self.path)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(self.path)

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
    """True = 临时可重试（429/5xx），False = 永久配置错误。"""
    return status_code == 429 or status_code >= 500


def post_with_retry(
    session: requests.Session,
    url: str,
    *,
    json_body: dict,
    headers: dict,
    timeout: float,
    attempts: int = MAX_POST_ATTEMPTS,
) -> dict:
    """可安全重试的 POST：指数退避 + 随机抖动；4xx 直接判定永久错误。"""
    last_exc: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            resp = session.post(url, json=json_body, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            delay = (2**attempt) + random.uniform(0, 0.5)
            log.warning("网络错误（第 %d 次）: %s，%.1fs 后重试", attempt + 1, exc, delay)
            time.sleep(delay)
            continue
        if resp.status_code >= 400:
            detail = resp.text[:300]
            if classify_status(resp.status_code):
                delay = (2**attempt) + random.uniform(0, 0.5)
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
        resp.raise_for_status()
        return resp.json()

    def fetch_users(self) -> list[dict]:
        payload = self.local_get("/api/v1/users", {})
        return [
            {
                "id": u.get("id"),
                "email": u.get("email") or "",
                "name": u.get("name") or "",
                "role": u.get("role") or "user",
                "created_at": u.get("created_at") or None,
                "updated_at": u.get("updated_at") or None,
            }
            for u in payload.get("users") or []
            if u.get("id")
        ]

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
        payload = self._push_payload(users, records, source_instance_id)
        sent = len(records)
        body = post_with_retry(
            self.session,
            f"{self.config.cloud_hub_url}/api/v1/sync/push",
            json_body=payload,
            headers={"Authorization": f"Bearer {self.config.cloud_api_key}"},
            timeout=self.config.request_timeout_seconds,
        )
        device_id = payload["device"]["id"]
        return validate_push_response(
            body, sent=sent, device_id=device_id, source_instance_id=source_instance_id
        )

    @staticmethod
    def _record_wire(r: dict) -> dict:
        return {
            "local_id": r["id"],
            "user_id": r.get("user_id") or "",
            "nickname": r.get("nickname") or "",
            "model_name": r.get("model_name") or "",
            "input_tokens": int(r.get("input_tokens") or 0),
            "output_tokens": int(r.get("output_tokens") or 0),
            "created_at": r.get("created_at") or utc_now_iso(),
        }

    @staticmethod
    def _record_reject_reason(r: dict) -> Optional[str]:
        """镜像云端 RecordIn 的确定性拒因（400 → PermanentConfigError）。

        单条这样的记录会让整批被 400 拒绝且游标不推进：同一批毒数据每个
        降级周期重推一次，其后所有记录无限期阻塞。云端规则（models.py）:
        user_id 非空；created_at 为合法 ISO 8601 且不超前 48 小时。
        """
        if not (r.get("user_id") or ""):
            return "user_id 为空"
        created = str(r.get("created_at") or "").strip()
        if created:
            raw = created.replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(raw)
            except ValueError:
                return f"created_at 不是合法的 ISO 8601 时间: {created!r}"
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt > datetime.now(timezone.utc) + MAX_FUTURE_SKEW:
                return f"created_at 超前当前时间过多: {created}"
        return None

    def _wire_valid(self, records: list[dict]) -> tuple[list[dict], int]:
        """拆分可同步/必被云端拒绝的记录；跳过项计数并写入状态文件。"""
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
        if skipped:
            if skipped > 5:
                log.warning("本批共跳过 %d 条无法同步的记录", skipped)
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
        if meta:
            live = str(meta.get("source_instance_id") or "")
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
        users = self.fetch_users()
        fetched = 0
        inserted = 0
        first_batch = True
        while True:
            after_id = self.state.cursor
            payload = self.local_get(
                "/api/v1/sync/records",
                {
                    "after_id": after_id,
                    "snapshot_max_id": snapshot_max_id,
                    "limit": self.config.batch_size,
                },
            )
            records = payload.get("records") or []
            if not records:
                if first_batch:
                    # 本轮无新数据：发送心跳（携带 users 以同步改名/角色）
                    result = self.push_batch(users, [], source)
                    log.info(
                        "心跳完成: users=%d received=%d", result.get("users_upserted", 0), 0
                    )
                break
            fetched += len(records)
            send_users = users if first_batch else []
            wire_records, _skipped = self._wire_valid(records)
            result = self.push_batch(send_users, wire_records, source)
            inserted += int(result.get("inserted") or 0)
            # 每批成功即推进游标并落盘：云端故障只影响未确认批次
            self.state.cursor = int(records[-1]["id"])
            self.state.data["pushed_records"] += int(result.get("inserted") or 0)
            self.state.save()
            first_batch = False
            if len(records) < self.config.batch_size:
                break
        return {"mode": "cursor", "fetched": fetched, "inserted": inserted}

    def _run_time_round(self, source: str) -> dict:
        snapshot_end = utc_now_iso()
        watermark = self.state.watermark
        users = self.fetch_users()

        records: list[dict] = []
        page = 1
        while True:
            params: dict[str, Any] = {"end_time": snapshot_end, "page": page, "page_size": 200}
            if watermark:
                params["start_time"] = watermark
            payload = self.local_get("/api/v1/records", params)
            batch = payload.get("records") or []
            records.extend(batch)
            total = int(payload.get("total") or 0)
            if not batch or len(records) >= total:
                break
            page += 1

        records.sort(key=lambda r: (r.get("created_at") or "", r.get("id") or 0))
        if not records:
            result = self.push_batch(users, [], source)
            log.info(
                "心跳完成: users=%d", result.get("users_upserted", 0)
            )
            return {"mode": "time", "fetched": 0, "inserted": 0}

        fetched = len(records)
        inserted = 0
        for i in range(0, fetched, self.config.batch_size):
            chunk = records[i : i + self.config.batch_size]
            send_users = users if i == 0 else []
            wire_records, _skipped = self._wire_valid(chunk)
            result = self.push_batch(send_users, wire_records, source)
            inserted += int(result.get("inserted") or 0)
            # 批内按时间升序，推进水位线到本批最大时间（含 1 秒重叠，靠云端去重）
            self.state.watermark = chunk[-1].get("created_at") or snapshot_end
            self.state.data["pushed_records"] += int(result.get("inserted") or 0)
            self.state.save()
        return {"mode": "time", "fetched": fetched, "inserted": inserted}

    # ------------------------------------------------------------ 主循环

    def run_forever(self) -> None:
        device_id = self.config.device_id or self.state.device_id
        log.info(
            "启动 agent v2: device=%s 本地=%s → 云端=%s 间隔=%ss",
            device_id,
            self.config.local_monitor_url,
            self.config.cloud_hub_url,
            self.config.sync_interval_seconds,
        )
        while True:
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
            time.sleep(interval)

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
    agent.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
