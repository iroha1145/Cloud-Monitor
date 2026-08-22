"""官方 token-monitor hub 的代理层（协议权威 = vendored Node 服务）。

职责划分:
- Node tm-core（vendored 官方代码, 未修改）: payload 规范化、设备记录合并、
  多设备聚合（过期/陈旧判定）、history、limits、subscriptions、SSE 广播、
  devices.json 持久化。所有官方响应原样透传，不重造。
- Python 本层: 鉴权（TOKEN_MONITOR_SECRET，只作用于 token-monitor 端点，
  与 OpenWebUI 链路的 API_KEY/ACCESS_TOKEN 完全隔离）、转发前的严格载荷
  校验、ASGI 级 1MiB 限流、SQLite 5 分钟桶历史快照（长期时间序列，官方
  不提供）、v1 旧表迁移。面板数据（/api/v1/tm/*）在 tm_overview.py。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .db import Database
from .tm_snapshots import (
    delete_device_snapshots,
    legacy_device_payloads,
    migrate_legacy_tables,
    write_snapshot,
)
from .tm_validate import PayloadValidationError, is_limits_only_update, validate_ingest_payload

log = logging.getLogger("tm-proxy")

UPSTREAM_TIMEOUT = 15.0
SSE_HEARTBEAT_HINT = b": hb"


class TmCore:
    """官方 Node hub 的 HTTP 客户端。"""

    def __init__(self, base_url: str, secret: str):
        self.base_url = base_url.rstrip("/")
        self.secret = secret

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
        timeout: float = UPSTREAM_TIMEOUT,
    ) -> httpx.Response:
        return httpx.request(
            method,
            f"{self.base_url}{path}",
            json=json_body,
            headers=self.headers(),
            timeout=timeout,
        )

    def health(self) -> Optional[dict]:
        try:
            resp = httpx.get(f"{self.base_url}/api/health", timeout=5.0)
            return resp.json() if resp.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None


def _proxy_response(resp: httpx.Response) -> JSONResponse:
    return JSONResponse(status_code=resp.status_code, content=resp.json())


def build_tm_router(settings: Settings, db: Database, core: TmCore) -> APIRouter:
    router = APIRouter()
    _async_client: Optional[httpx.AsyncClient] = None

    def tm_auth(request: Request) -> None:
        if not settings.tm_ingest_secret:
            raise HTTPException(
                status_code=404,
                detail="未启用 token-monitor 接入（缺少 TOKEN_MONITOR_SECRET）",
            )
        secret = settings.tm_ingest_secret
        header = request.headers.get("x-token-monitor-secret") or ""
        auth = request.headers.get("authorization") or ""
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        import hmac

        if not hmac.compare_digest((header or bearer).encode(), secret.encode()):
            raise HTTPException(status_code=401, detail="unauthorized")

    # ------------------------------------------------------------ health

    @router.get("/api/health")
    def tm_health() -> JSONResponse:
        upstream = core.health()
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
        return JSONResponse(status_code=200, content=upstream)

    # ------------------------------------------------------------ ingest

    @router.post("/api/ingest")
    def tm_ingest(request: Request, payload: dict) -> JSONResponse:
        tm_auth(request)
        try:
            validate_ingest_payload(payload)
        except PayloadValidationError as exc:
            return JSONResponse(
                status_code=400, content={"error": "bad_request", "message": str(exc)}
            )
        try:
            resp = core.request("POST", "/api/ingest", json_body=payload)
        except httpx.HTTPError as exc:
            log.error("tm-core 转发失败: %s", exc)
            return JSONResponse(
                status_code=502, content={"error": "bad_gateway", "message": str(exc)}
            )
        if resp.status_code == 200:
            try:
                write_snapshot_for_device(db, core, payload)
            except Exception as exc:  # 快照失败不阻断协议路径
                log.warning("快照写入失败（不影响官方协议响应）: %s", exc)
        try:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        except ValueError:
            return JSONResponse(status_code=502, content={"error": "bad_gateway"})

    def write_snapshot_for_device(db: Database, core: TmCore, payload: dict) -> None:
        device_id = str(payload.get("deviceId") or payload.get("id") or "")
        if not device_id:
            return
        devices = core.request("GET", "/api/devices")
        if devices.status_code != 200:
            return
        for record in devices.json().get("devices") or []:
            if str(record.get("deviceId")) == device_id:
                write_snapshot(
                    db,
                    device_id=device_id,
                    record=record,
                    incoming=payload,
                    limits_only=is_limits_only_update(payload),
                )
                return

    # ------------------------------------------------------------ 只读透传

    @router.get("/api/stats")
    def tm_stats(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxy_response(core.request("GET", "/api/stats"))

    @router.get("/api/devices")
    def tm_devices(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxy_response(core.request("GET", "/api/devices"))

    @router.get("/api/history")
    def tm_history(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxy_response(core.request("GET", "/api/history"))

    @router.delete("/api/devices/{device_id}")
    def tm_delete_device(device_id: str, request: Request) -> JSONResponse:
        tm_auth(request)
        resp = core.request("DELETE", f"/api/devices/{device_id}")
        if resp.status_code == 200:
            deleted = delete_device_snapshots(db, device_id)
            log.info("设备 %s 已删除（清理 %d 条快照）", device_id, deleted)
        return _proxy_response(resp)

    # ------------------------------------------------------------ subscriptions

    @router.get("/api/subscriptions")
    def tm_get_subscriptions(request: Request) -> JSONResponse:
        tm_auth(request)
        return _proxy_response(core.request("GET", "/api/subscriptions"))

    @router.put("/api/subscriptions")
    def tm_put_subscriptions(request: Request, payload: dict) -> JSONResponse:
        tm_auth(request)
        return _proxy_response(
            core.request("PUT", "/api/subscriptions", json_body=payload)
        )

    # ------------------------------------------------------------ SSE

    @router.get("/api/stats/stream")
    async def tm_stats_stream(request: Request):
        tm_auth(request)
        nonlocal _async_client
        if _async_client is None:
            _async_client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None))

        upstream_req = _async_client.build_request(
            "GET",
            f"{core.base_url}/api/stats/stream",
            headers=core.headers(),
        )
        upstream = await _async_client.send(upstream_req, stream=True)

        async def event_stream():
            try:
                async for chunk in upstream.aiter_raw():
                    if chunk:
                        yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            event_stream(),
            status_code=upstream.status_code,
            media_type="text/event-stream",
            headers={
                "cache-control": "no-cache, no-transform",
                "x-accel-buffering": "no",
                "connection": "keep-alive",
            },
        )

    return router


def bootstrap_tm_layer(settings: Settings, db: Database) -> Optional[TmCore]:
    """启动时接线：建表、迁移旧表、回灌 v1 设备到官方 hub。"""
    from .tm_snapshots import ensure_schema

    ensure_schema(db)
    migrate_legacy_tables(db)
    if not settings.tm_ingest_secret:
        return None
    core = TmCore(settings.tm_core_url, settings.tm_ingest_secret)
    if core.health() is None:
        log.warning(
            "tm-core 上游不可达 (%s)：token-monitor 端点将返回 502/503，"
            "OpenWebUI 链路不受影响",
            settings.tm_core_url,
        )
        return core
    for payload in legacy_device_payloads(db):
        try:
            core.request("POST", "/api/ingest", json_body=payload)
        except httpx.HTTPError as exc:
            log.warning("v1 设备回灌失败（可在 tm-core 恢复后重启服务重试）: %s", exc)
    return core
