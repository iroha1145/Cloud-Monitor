"""官方 token-monitor hub 的代理层（协议权威 = vendored Node 服务）。

职责划分:
- Node tm-core（vendored 官方代码, 未修改）: payload 规范化、设备记录合并、
  多设备聚合（过期/陈旧判定）、history、limits、subscriptions、SSE 广播、
  devices.json 持久化。所有官方响应原样透传，不重造。
- Python 本层: 鉴权（TOKEN_MONITOR_SECRET，与 OpenWebUI 链路密钥隔离）、
  转发前的严格载荷校验、ASGI 级 1MiB 限流、事务发件箱保证的 SQLite
  5 分钟桶快照、健康检查（live/ready）、/api/v1/tm/*（tm_overview.py）、
  v1 旧表迁移。

可靠性（P0-1）: ingest 先记 pending outbox → 转发 → 从响应 stats.devices
取规范化记录写快照并标记 done（同请求闭环，不再额外 GET /api/devices）；
快照失败时 outbox 留待本地重放；上游暂时失败则保留完整载荷，按设备顺序
有界重试，返回真实失败或 503 queued，未确认前不承诺 200。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .db import Database
from .tm_outbox import (
    MAX_PENDING_DEFAULT,
    OutboxFullError,
    ensure_schema as ensure_outbox_schema,
    purge_device as purge_device_outbox,
    replay_pending,
    replayable_count,
)
from .tm_forwarding import DeviceDeletingError, RETRY_BASE_SECONDS, forwarding_queue
from .tm_snapshots import (
    delete_device_snapshots,
    ensure_schema,
    legacy_device_payloads,
    legacy_device_deleted,
    mark_legacy_deleted,
    mark_legacy_reingested,
    mark_legacy_rejected,
    migrate_legacy_tables,
)
from .tm_validate import (
    PayloadValidationError,
)

log = logging.getLogger("tm-proxy")

CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 15.0


class UpstreamUnavailable(Exception):
    """tm-core 连接层不可达（统一映射 503，允许客户端重连/重试）。"""


class TmCore:
    """官方 Node hub 的 HTTP 客户端（复用注入的 httpx.Client 连接池）。"""

    def __init__(self, base_url: str, secret: str, client: Optional[httpx.Client] = None):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self._client = client

    def bind_client(self, client: httpx.Client) -> "TmCore":
        self._client = client
        return self

    def headers(self) -> dict[str, str]:
        return {
            "X-Token-Monitor-Secret": self.secret,
            "Authorization": f"Bearer {self.secret}",
        }

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[dict] = None,
        timeout: Optional[httpx.Timeout] = None,
    ) -> httpx.Response:
        if self._client is None:
            # 非 lifespan 用法（直连 ASGI 测试等）：临时客户端兜底
            try:
                return httpx.request(
                    method,
                    f"{self.base_url}{path}",
                    json=json_body,
                    headers=self.headers(),
                    timeout=timeout or httpx.Timeout(CONNECT_TIMEOUT, read=READ_TIMEOUT),
                )
            except httpx.HTTPError as exc:
                raise UpstreamUnavailable(f"tm-core 请求失败: {exc}") from exc
        try:
            return self._client.request(
                method,
                f"{self.base_url}{path}",
                json=json_body,
                headers=self.headers(),
                timeout=timeout or httpx.Timeout(CONNECT_TIMEOUT, read=READ_TIMEOUT),
            )
        except httpx.HTTPError as exc:
            raise UpstreamUnavailable(f"tm-core 请求失败: {exc}") from exc

    def health(self) -> Optional[dict]:
        """经共享客户端探测 tm-core（ready 探针高频调用，避免每次新建连接）。"""
        try:
            resp = self.request("GET", "/api/health", timeout=httpx.Timeout(5.0))
        except UpstreamUnavailable:
            return None
        if resp.status_code != 200:
            return None
        try:
            return resp.json()
        except ValueError:
            return None


def _proxy_response(resp: httpx.Response, *, minimal_ingest: bool = False) -> JSONResponse:
    headers = {}
    if "Retry-After" in resp.headers:
        headers["Retry-After"] = resp.headers["Retry-After"]
    try:
        content = resp.json()
    except ValueError:
        return JSONResponse(status_code=502, content={"error": "bad_gateway"}, headers=headers)
    if minimal_ingest and resp.status_code == 200 and isinstance(content, dict) and content.get("ok") is True:
        content = {key: content[key] for key in ("ok", "deviceId") if key in content}
    return JSONResponse(status_code=resp.status_code, content=content, headers=headers)


def request_tm_secret(request: Request) -> str:
    """与官方 requestSecret 一致：出现 Bearer 就只看 Bearer，即使值为空。"""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("x-token-monitor-secret") or ""


def _unavailable_response(exc: Exception) -> JSONResponse:
    message = str(exc).strip() or type(exc).__name__
    return JSONResponse(
        status_code=503,
        content={"error": "upstream_unavailable", "message": message[:200]},
    )


def build_tm_router(settings: Settings, db: Database) -> APIRouter:
    """路由在调用期从 app.state 取 core（lifespan 绑定共享客户端）。"""
    router = APIRouter()
    forwarding = forwarding_queue(db, max_pending=settings.tm_outbox_max_pending)

    def core_of(request: Request) -> TmCore:
        return request.app.state.tm_core

    def _invalidate_overview(request: Request) -> None:
        cache = getattr(request.app.state, "overview_cache", None)
        if cache is not None:
            cache.invalidate()

    def _wake_replay(request: Request) -> None:
        # H-8：空 outbox 不唤醒整轮维护（避免每次成功 ingest 都 WAL checkpoint）。
        if replayable_count(db) <= 0 and not forwarding.has_pending():
            return
        background = getattr(request.app.state, "tm_background", None)
        if background is not None:
            background.wake()

    def tm_auth(request: Request) -> None:
        if not settings.tm_ingest_secret:
            from .auth import CodedHTTPException

            raise CodedHTTPException(
                404,
                "token_monitor_secret_unconfigured",
                "未启用 token-monitor 接入（缺少 TOKEN_MONITOR_SECRET）",
            )
        import hmac

        secret = settings.tm_ingest_secret
        provided = request_tm_secret(request)
        if not provided or not hmac.compare_digest(provided.encode(), secret.encode()):
            raise HTTPException(status_code=401, detail="unauthorized")

    # ------------------------------------------------------------ health

    @router.get("/api/health")
    def tm_health(request: Request) -> JSONResponse:
        if not settings.tm_ingest_secret:
            return JSONResponse(
                status_code=404,
                content={
                    "ok": False,
                    "error": "disabled",
                    "detail": "TOKEN_MONITOR_SECRET 未配置，token-monitor 接入已停用",
                },
            )
        upstream = core_of(request).health()
        if upstream is None:
            return JSONResponse(
                status_code=503,
                content={
                    "ok": False,
                    "role": "hub",
                    "runtime": "cloud-monitor",
                    "error": "tm-core 上游不可用",
                },
            )
        public = {
            key: upstream[key]
            for key in (
                "ok",
                "role",
                "hubBuild",
                "runtime",
                "version",
                "secretRequired",
                "now",
            )
            if key in upstream
        }
        return JSONResponse(status_code=200, content=public or {"ok": True, "role": "hub"})

    # ------------------------------------------------------------ ingest（outbox 闭环）

    def _tm_ingest_sync(request: Request, payload: dict) -> JSONResponse:
        try:
            request_id = forwarding.enqueue(payload)
        except PayloadValidationError as exc:
            return JSONResponse(
                status_code=400, content={"error": "bad_request", "message": str(exc)}
            )
        except OutboxFullError as exc:
            return JSONResponse(
                status_code=503,
                content={"error": "snapshot_backpressure", "message": str(exc)},
                headers={"Retry-After": str(RETRY_BASE_SECONDS)},
            )
        except DeviceDeletingError as exc:
            return JSONResponse(
                status_code=503, content={"error": "device_busy", "message": str(exc)},
                headers={"Retry-After": str(RETRY_BASE_SECONDS)},
            )
        device_id = str(payload.get("deviceId") or payload.get("id") or "")
        attempt = forwarding.process_device(core_of(request), device_id)
        _wake_replay(request)
        # The core always returns the full record for durable acknowledgement.
        # Trim only the external response after the forwarding queue saved it.
        minimal = request.headers.get("x-token-monitor-response", "").strip().lower() == "minimal"
        if attempt.request_id == request_id and attempt.response is not None:
            return _proxy_response(attempt.response, minimal_ingest=minimal)
        completed = forwarding.result_for_request(core_of(request), request_id)
        if completed is not None:
            attempt = completed
            if completed.response is not None:
                return _proxy_response(completed.response, minimal_ingest=minimal)
        return JSONResponse(
            status_code=503,
            content={
                "error": attempt.error_code if attempt.request_id == request_id else "upstream_queued",
                "message": attempt.message if attempt.request_id == request_id else "上报已暂存，等待较早的请求完成",
            },
            headers={"Retry-After": str(attempt.retry_after)},
        )

    @router.post("/api/ingest")
    async def tm_ingest(request: Request) -> JSONResponse:
        tm_auth(request)
        try:
            payload = await request.json()
        except (ValueError, UnicodeDecodeError, RecursionError):
            # json.loads 对深层嵌套抛 RecursionError，仍是客户端正文问题。
            return JSONResponse(
                status_code=400, content={"error": "bad_request", "message": "invalid json"}
            )
        from starlette.concurrency import run_in_threadpool

        return await run_in_threadpool(_tm_ingest_sync, request, payload)

    # ------------------------------------------------------------ 只读透传（统一 503）

    def _proxied(request: Request, method: str, path: str) -> JSONResponse:
        try:
            return _proxy_response(core_of(request).request(method, path))
        except UpstreamUnavailable as exc:
            return _unavailable_response(exc)

    @router.get("/api/stats")
    def tm_stats(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxied(request, "GET", "/api/stats")

    @router.get("/api/devices")
    def tm_devices(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxied(request, "GET", "/api/devices")

    @router.get("/api/history")
    def tm_history(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxied(request, "GET", "/api/history")

    @router.delete("/api/devices/{device_id:path}")
    def tm_delete_device(device_id: str, request: Request) -> JSONResponse:
        tm_auth(request)
        try:
            with forwarding.device_operation(device_id, "delete") as acquired:
                if not acquired:
                    return JSONResponse(
                        status_code=503,
                        content={"error": "device_busy", "message": "设备正在同步，请稍后重试删除"},
                        headers={"Retry-After": str(RETRY_BASE_SECONDS)},
                    )
                try:
                    resp = core_of(request).request(
                        "DELETE", f"/api/devices/{quote(device_id, safe='')}"
                    )
                except UpstreamUnavailable as exc:
                    return _unavailable_response(exc)
                if resp.status_code == 200:
                    with db.transaction():
                        deleted = delete_device_snapshots(db, device_id)
                        purged = purge_device_outbox(db, device_id)
                        mark_legacy_deleted(db, device_id)
                    log.info("设备 %s 已删除（清理 %d 条快照，%d 条 outbox）", device_id, deleted, purged)
                    _invalidate_overview(request)
                return _proxy_response(resp)
        finally:
            _wake_replay(request)

    # ------------------------------------------------------------ subscriptions

    @router.get("/api/subscriptions")
    def tm_get_subscriptions(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxied(request, "GET", "/api/subscriptions")

    @router.put("/api/subscriptions")
    async def tm_put_subscriptions(request: Request) -> JSONResponse:
        tm_auth(request)
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(
                status_code=400, content={"error": "bad_request", "message": "invalid json"}
            )
        from starlette.concurrency import run_in_threadpool

        def _put() -> JSONResponse:
            try:
                resp = core_of(request).request(
                    "PUT", "/api/subscriptions", json_body=payload
                )
            except UpstreamUnavailable as exc:
                return _unavailable_response(exc)
            return _proxy_response(resp)

        return await run_in_threadpool(_put)

    # ------------------------------------------------------------ SSE（错误不伪装成事件流）

    @router.get("/api/stats/stream")
    async def tm_stats_stream(request: Request):
        tm_auth(request)
        async_client: httpx.AsyncClient = getattr(
            request.app.state, "http_sse", request.app.state.http_async
        )
        core = core_of(request)
        headers = core.headers()
        if request.headers.get("x-token-monitor-stream", "").strip() == "2":
            headers["X-Token-Monitor-Stream"] = "2"
        upstream_req = async_client.build_request(
            "GET",
            f"{core.base_url}/api/stats/stream",
            headers=headers,
        )
        try:
            upstream = await async_client.send(upstream_req, stream=True)
        except httpx.HTTPError as exc:
            return _unavailable_response(exc)
        if upstream.status_code != 200:
            status = upstream.status_code
            await upstream.aclose()
            return JSONResponse(
                status_code=502,
                content={"error": "bad_gateway", "upstream_status": status},
            )

        async def event_stream():
            try:
                async for chunk in upstream.aiter_raw():
                    if chunk:
                        yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            event_stream(),
            status_code=200,
            media_type="text/event-stream",
            headers={
                "cache-control": "no-cache, no-transform",
                "x-accel-buffering": "no",
                "connection": "keep-alive",
            },
        )

    return router


class TmBackground:
    """后台维护：outbox 重放 + tm-core 延迟初始化/旧数据回填重试。"""

    def __init__(self, settings: Settings, db: Database, core: TmCore):
        self.settings = settings
        self.db = db
        self.core = core
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.forwarding = forwarding_queue(
            db, max_pending=getattr(settings, "tm_outbox_max_pending", MAX_PENDING_DEFAULT)
        ) if db is not None else None

    def wake(self) -> None:
        self._wake.set()

    def start(self) -> None:
        from .tm_outbox import reject_exhausted_pending

        try:
            reject_exhausted_pending(self.db)
        except Exception as exc:  # noqa: BLE001
            log.warning("启动时清理耗尽 attempts 的 pending 失败: %s", exc)
        self._thread = threading.Thread(target=self._loop, name="tm-maintenance", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            # The lifespan closes HTTP/SQLite immediately after stop(). An
            # in-flight request can exceed 5s; never close underneath it.
            thread.join()

    def _loop(self) -> None:
        bootstrapped = False
        try:
            bootstrapped = self._bootstrap()
        except Exception as exc:  # Retry transient startup failures next cycle.
            log.warning("tm-core 后台初始化异常: %s", exc)
        interval = self.settings.tm_background_interval
        next_maintenance = time.monotonic() + interval
        backoff = 0.0  # 上一圈出错后的最短等待；成功一圈即清零
        while not self._stop.is_set():
            delay = max(0.1, next_maintenance - time.monotonic())
            if self.forwarding is not None:
                try:
                    delay = self.forwarding.next_delay(delay)
                except Exception as exc:  # noqa: BLE001 — 线程退出会让重放与转发静默停摆
                    log.warning("转发排期读取失败，按维护间隔等待: %s", exc)
            # 写失败时到期行的排期改不回去，next_delay 会一直报 0.1 秒，所以出错后要退避
            self._wake.wait(max(delay, backoff))
            self._wake.clear()
            if self._stop.is_set():
                break
            failed = False
            if self.forwarding is not None:
                try:
                    self.forwarding.process_due(self.core, should_stop=self._stop.is_set)
                except Exception as exc:  # noqa: BLE001 — 后台任务不得崩溃进程
                    failed = True
                    log.warning("转发处理异常: %s", exc)
            # 与转发分开：转发出错不能拖掉到期的重放与清理
            maintenance_due = time.monotonic() >= next_maintenance
            try:
                if maintenance_due or replayable_count(self.db) > 0:
                    replay_pending(self.db, self.core, should_stop=self._stop.is_set)
            except Exception as exc:  # noqa: BLE001 — 后台任务不得崩溃进程
                failed = True
                log.warning("outbox 后台重放异常: %s", exc)
            if maintenance_due:
                # 必须在 try 之外：维护失败也要排下一次，否则等待时长塌到 0.1 秒空转
                next_maintenance = time.monotonic() + interval
            backoff = min(max(backoff * 2, RETRY_BASE_SECONDS), interval) if failed else 0.0
            if not bootstrapped and not self._stop.is_set():
                try:
                    bootstrapped = self._bootstrap()
                except Exception as exc:
                    log.warning("tm-core 后台初始化异常: %s", exc)

    def _bootstrap(self) -> bool:
        """tm-core 延迟就绪时自动重试初始化与 v2 旧数据回填（幂等标记）。"""
        if self._stop.is_set():
            return False
        if not self.settings.tm_ingest_secret:
            return True
        if self.core.health() is None:
            return False
        for payload in legacy_device_payloads(self.db):
            if self._stop.is_set():
                return False
            device_key = str(payload.get("deviceId") or "")
            try:
                with self.forwarding.device_operation(device_key, "bootstrap") as acquired:
                    if not acquired:
                        return False
                    # The list may have been fetched before a successful DELETE.
                    # Re-check its persistent migration-only tombstone while the
                    # deletion/forwarding owner cannot change underneath us.
                    if legacy_device_deleted(self.db, device_key):
                        continue
                    # An existing core record is newer authority than a legacy
                    # migration payload. Hold ownership across this read and
                    # POST, including foreground enqueue/dispatch races.
                    if self.db.fetchone(
                        "SELECT 1 FROM tm_ingest_outbox WHERE device_id=? "
                        "AND state='pending' AND forward_payload_json IS NOT NULL LIMIT 1",
                        (device_key,),
                    ):
                        return False
                    existing = self.core.request("GET", "/api/devices")
                    if existing.status_code != 200:
                        return False
                    devices = existing.json().get("devices")
                    if not isinstance(devices, list):
                        return False
                    if any(isinstance(row, dict) and str(row.get("deviceId")) == device_key for row in devices):
                        continue
                    if self._stop.is_set():
                        return False
                    resp = self.core.request("POST", "/api/ingest", json_body=payload)
            except (UpstreamUnavailable, httpx.HTTPError) as exc:
                log.warning("v1 设备回灌失败（将随后台周期重试）: %s", exc)
                return False
            if resp.status_code != 200:
                # 仅 payload 校验失败（400/422）是确定性拒绝：重试到永远也不会
                # 成功。404/405 是路径/方法不兼容、401/403 是密钥配错、
                # 408/429/5xx 是临时失败——都保持整轮重试，升级/修好后再灌。
                if resp.status_code in (400, 422):
                    if not device_key:
                        # 无法定位设备，无法按设备标记：保守起见保持整轮重试
                        return False
                    mark_legacy_rejected(self.db, device_key)
                    log.warning(
                        "v1 设备回灌被 tm-core 确定性拒绝（HTTP %s，已标记跳过设备 %s）: %s",
                        resp.status_code,
                        device_key,
                        resp.text[:200],
                    )
                    continue
                log.warning(
                    "v1 设备回灌被 tm-core 拒绝（HTTP %s，将随后台周期重试）: %s",
                    resp.status_code,
                    resp.text[:200],
                )
                return False
        if self._stop.is_set():
            return False
        # 只有全部 payload 成功提交后才写幂等标记；失败时下一轮仍能重试。
        mark_legacy_reingested(self.db)
        try:
            replay_pending(self.db, self.core, should_stop=self._stop.is_set)
        except Exception as exc:  # noqa: BLE001
            log.warning("启动重放异常: %s", exc)
        return True


def bootstrap_tm_layer(
    settings: Settings, db: Database, client: Optional[httpx.Client] = None
) -> Optional[TmCore]:
    """启动接线：建表、迁移旧表、构造 core（后台线程负责重试与重放）。"""
    ensure_schema(db)
    ensure_outbox_schema(db)
    migrate_legacy_tables(db)
    if not settings.tm_ingest_secret:
        return None
    core = TmCore(settings.tm_core_url, settings.tm_ingest_secret, client)
    if core.health() is None:
        log.warning(
            "tm-core 上游暂不可达 (%s)：后台线程将自动重试初始化与回填",
            settings.tm_core_url,
        )
    return core
