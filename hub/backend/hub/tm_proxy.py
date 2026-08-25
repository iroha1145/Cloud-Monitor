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
快照失败时 outbox 留待重放（官方数据不丢，健康暴露 snapshot_degraded）。
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .db import Database
from .tm_outbox import (
    OutboxFullError,
    ensure_schema as ensure_outbox_schema,
    mark_done,
    mark_failed,
    mark_rejected,
    new_request_id,
    purge_device as purge_device_outbox,
    record_pending,
    replay_pending,
    set_snapshot_status,
)
from .tm_snapshots import (
    delete_device_snapshots,
    ensure_schema,
    legacy_device_payloads,
    mark_legacy_reingested,
    migrate_legacy_tables,
    write_snapshot,
)
from .tm_validate import (
    PayloadValidationError,
    is_limits_only_update,
    validate_ingest_payload,
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
        try:
            resp = httpx.get(f"{self.base_url}/api/health", timeout=5.0)
            return resp.json() if resp.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None


def _proxy_response(resp: httpx.Response) -> JSONResponse:
    try:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    except ValueError:
        return JSONResponse(status_code=502, content={"error": "bad_gateway"})


def _unavailable_response(exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "upstream_unavailable", "message": str(exc)[:200]},
    )


def build_tm_router(settings: Settings, db: Database) -> APIRouter:
    """路由在调用期从 app.state 取 core（lifespan 绑定共享客户端）。"""
    router = APIRouter()

    def core_of(request: Request) -> TmCore:
        return request.app.state.tm_core

    def tm_auth(request: Request) -> None:
        if not settings.tm_ingest_secret:
            raise HTTPException(
                status_code=404,
                detail="未启用 token-monitor 接入（缺少 TOKEN_MONITOR_SECRET）",
            )
        import hmac

        secret = settings.tm_ingest_secret
        header = request.headers.get("x-token-monitor-secret") or ""
        auth = request.headers.get("authorization") or ""
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not hmac.compare_digest((header or bearer).encode(), secret.encode()):
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
                    "snapshot": snapshot_health_of(db),
                },
            )
        return JSONResponse(status_code=200, content=upstream)

    def snapshot_health_of(db: Database) -> dict:
        from .tm_outbox import snapshot_health

        return snapshot_health(db)

    # ------------------------------------------------------------ ingest（outbox 闭环）

    @router.post("/api/ingest")
    def tm_ingest(request: Request, payload: dict) -> JSONResponse:
        tm_auth(request)
        try:
            validate_ingest_payload(payload)
        except PayloadValidationError as exc:
            return JSONResponse(
                status_code=400, content={"error": "bad_request", "message": str(exc)}
            )
        device_id = str(payload.get("deviceId") or payload.get("id") or "")
        request_id = new_request_id()
        try:
            record_pending(
                db,
                request_id=request_id,
                device_id=device_id,
                payload=payload,
                max_pending=settings.tm_outbox_max_pending,
            )
        except OutboxFullError as exc:
            return JSONResponse(
                status_code=503,
                content={"error": "snapshot_backpressure", "message": str(exc)},
            )

        try:
            resp = core_of(request).request("POST", "/api/ingest", json_body=payload)
        except UpstreamUnavailable as exc:
            log.warning("tm-core 不可达（outbox pending 留待重放/重试）: %s", exc)
            return _unavailable_response(exc)
        if resp.status_code != 200:
            if 400 <= resp.status_code < 500:
                mark_rejected(db, request_id, f"upstream HTTP {resp.status_code}")
            else:
                mark_failed(db, request_id, f"upstream HTTP {resp.status_code}")
            return _proxy_response(resp)

        try:
            body = resp.json()
        except ValueError:
            mark_failed(db, request_id, "upstream response is not JSON")
            set_snapshot_status(
                db, success=False, error="upstream response is not JSON"
            )
            return JSONResponse(status_code=502, content={"error": "bad_gateway"})

        # 快照：直接取本次响应内的规范化记录（同请求闭环，不串批）
        try:
            record = next(
                (
                    r
                    for r in (body.get("stats") or {}).get("devices") or []
                    if str(r.get("deviceId")) == device_id
                ),
                None,
            )
            if record is None:
                raise ValueError(
                    f"tm-core ingest response missing normalized device {device_id!r}"
                )
            write_snapshot(
                db,
                device_id=device_id,
                record=record or {},
                incoming=payload,
                limits_only=is_limits_only_update(payload),
            )
            mark_done(db, request_id)
            set_snapshot_status(db, success=True)
        except Exception as exc:  # noqa: BLE001 — outbox 兜底，不阻断协议响应
            mark_failed(db, request_id, str(exc))
            set_snapshot_status(db, success=False, error=str(exc))
            log.warning("快照写入失败（outbox 留待重放）: %s", exc)
        return JSONResponse(status_code=200, content=body)

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

    @router.delete("/api/devices/{device_id}")
    def tm_delete_device(device_id: str, request: Request) -> JSONResponse:
        tm_auth(request)
        try:
            resp = core_of(request).request("DELETE", f"/api/devices/{device_id}")
        except UpstreamUnavailable as exc:
            return _unavailable_response(exc)
        if resp.status_code == 200:
            deleted = delete_device_snapshots(db, device_id)
            purged = purge_device_outbox(db, device_id)
            log.info(
                "设备 %s 已删除（清理 %d 条快照，%d 条 outbox）",
                device_id,
                deleted,
                purged,
            )
        return _proxy_response(resp)

    # ------------------------------------------------------------ subscriptions

    @router.get("/api/subscriptions")
    def tm_get_subscriptions(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxied(request, "GET", "/api/subscriptions")

    @router.put("/api/subscriptions")
    def tm_put_subscriptions(request: Request, payload: dict) -> JSONResponse:
        tm_auth(request)
        try:
            resp = core_of(request).request(
                "PUT", "/api/subscriptions", json_body=payload
            )
        except UpstreamUnavailable as exc:
            return _unavailable_response(exc)
        return _proxy_response(resp)

    # ------------------------------------------------------------ SSE（错误不伪装成事件流）

    @router.get("/api/stats/stream")
    async def tm_stats_stream(request: Request):
        tm_auth(request)
        async_client: httpx.AsyncClient = request.app.state.http_async
        core = core_of(request)
        upstream_req = async_client.build_request(
            "GET",
            f"{core.base_url}/api/stats/stream",
            headers=core.headers(),
        )
        try:
            upstream = await async_client.send(upstream_req, stream=True)
        except httpx.HTTPError as exc:
            return JSONResponse(
                status_code=503,
                content={"error": "upstream_unavailable", "message": str(exc)[:200]},
            )
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
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="tm-maintenance", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)

    def _loop(self) -> None:
        bootstrapped = self._bootstrap()
        while not self._stop.wait(60.0):
            try:
                replay_pending(self.db, self.core)
            except Exception as exc:  # noqa: BLE001 — 后台任务不得崩溃进程
                log.warning("outbox 后台重放异常: %s", exc)
            if not bootstrapped:
                bootstrapped = self._bootstrap()

    def _bootstrap(self) -> bool:
        """tm-core 延迟就绪时自动重试初始化与 v2 旧数据回填（幂等标记）。"""
        if not self.settings.tm_ingest_secret:
            return True
        if self.core.health() is None:
            return False
        for payload in legacy_device_payloads(self.db):
            try:
                resp = self.core.request("POST", "/api/ingest", json_body=payload)
            except (UpstreamUnavailable, httpx.HTTPError) as exc:
                log.warning("v1 设备回灌失败（将随后台周期重试）: %s", exc)
                return False
            if resp.status_code != 200:
                # 4xx/5xx 同样是失败：此前只查传输层异常，密钥不一致等
                # 会被当成功写下永久标记，旧设备数据从此静默丢失
                log.warning(
                    "v1 设备回灌被 tm-core 拒绝（HTTP %s，将随后台周期重试）: %s",
                    resp.status_code,
                    resp.text[:200],
                )
                return False
        # 只有全部 payload 成功提交后才写幂等标记；失败时下一轮仍能重试。
        mark_legacy_reingested(self.db)
        try:
            replay_pending(self.db, self.core)
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
