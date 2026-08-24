from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .auth import (
    WriteBinding,
    enforce_device_binding,
    require_access_token,
    resolve_write_binding,
)
from .body_limit import TmBodyLimitMiddleware
from .config import Settings, load_settings
from .db import Database
from .models import SyncPushRequest
from .services import (
    apply_sync_push,
    list_devices,
    list_usage_page,
    list_users,
    usage_report,
)
from .tm_overview import build_tm_overview_router
from .tm_proxy import bootstrap_tm_layer, build_tm_router


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or load_settings()
    docs_urls = (
        {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}
        if settings.docs_enabled
        else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    )
    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        import httpx

        from .tm_proxy import TmBackground

        _app.state.http_sync = httpx.Client(
            timeout=httpx.Timeout(5.0, read=15.0), limits=httpx.Limits(max_connections=20)
        )
        _app.state.http_async = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, read=None), limits=httpx.Limits(max_connections=20)
        )
        if _app.state.tm_core is not None:
            _app.state.tm_core.bind_client(_app.state.http_sync)
            if settings.tm_background_enabled:
                background = TmBackground(settings, _app.state.db, _app.state.tm_core)
                background.start()
                _app.state.tm_background = background
        try:
            yield
        finally:
            if _app.state.tm_background is not None:
                _app.state.tm_background.stop()
            await _app.state.http_async.aclose()
            _app.state.http_sync.close()
            _app.state.db.close()

    app = FastAPI(
        title="Cloud Monitor 云端 Token 看板", version="3.0.0", lifespan=_lifespan, **docs_urls
    )
    app.state.settings = settings
    app.state.db = Database(settings.database_path)

    # token-monitor 官方协议层：协议权威 = tm-core（vendored Node），
    # Python 负责鉴权/校验/限流/快照/面板数据。core 在 lifespan 绑定共享
    # HTTP 客户端；非 lifespan 用法（部分测试）回退到按需客户端。
    tm_core = bootstrap_tm_layer(settings, app.state.db)
    app.state.tm_core = tm_core
    app.state.tm_background = None
    from .tm_provider_status import ProviderStatusService

    app.state.provider_status = ProviderStatusService(
        cache_seconds=settings.provider_status_cache_seconds,
        timeout_seconds=settings.provider_status_timeout_seconds,
        budget_seconds=settings.provider_status_budget_seconds,
    )
    app.include_router(build_tm_router(settings, app.state.db))
    # 云端用量面板数据（/api/v1/tm/overview + /api/v1/tm/subscriptions）
    app.include_router(build_tm_overview_router(settings, app.state.db))

    # ASGI receive 层实测限流：TM 写入端点 1MiB（官方上限），
    # /api/v1/sync/push 为可配置实际字节上限（P1-6，统一覆盖所有写接口）
    app.add_middleware(
        TmBodyLimitMiddleware,
        limits={
            "/api/ingest": 1024 * 1024,
            "/api/subscriptions": 1024 * 1024,
            "/api/v1/sync/push": settings.max_sync_body_bytes,
        },
    )

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )

    # 安全响应头（P1-8）：所有响应统一附加，不影响静态 UI 加载
    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("x-content-type-options", "nosniff")
        response.headers.setdefault("referrer-policy", "no-referrer")
        response.headers.setdefault(
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"
            " img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
            " base-uri 'none'; form-action 'self'",
        )
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={"error": "请求体校验失败", "details": jsonable_encoder(exc.errors())},
        )

    @app.on_event("shutdown")
    def close_db() -> None:
        # lifespan 关闭路径之外的兜底（TestClient 直接使用等场景）；幂等。
        app.state.db.close()

    def settings_dep() -> Settings:
        return app.state.settings

    def db_dep() -> Database:
        return app.state.db

    def ingest_auth(
        request: Request, cfg: Settings = Depends(settings_dep)
    ) -> WriteBinding:
        return resolve_write_binding(request, cfg)

    def read_auth(request: Request, cfg: Settings = Depends(settings_dep)) -> None:
        require_access_token(request, cfg)

    @app.get("/api/v1/health")
    def health() -> dict:
        from .tm_outbox import snapshot_health

        return {
            "ok": True,
            "role": "cloud-hub",
            "protocol_version": settings.protocol_version,
            "snapshot": snapshot_health(app.state.db),
        }

    @app.get("/api/v1/health/live")
    def health_live() -> dict:
        """存活探测：进程可响应即 200。"""
        return {"ok": True, "role": "cloud-hub"}

    @app.get("/api/v1/health/ready")
    def health_ready(request: Request) -> JSONResponse:
        """就绪探测：SQLite 读写、tm-core、快照/outbox 状态。"""
        components: dict[str, dict] = {}

        try:
            app.state.db.fetchone("SELECT 1 AS one")
            components["sqlite_read"] = {"ok": True}
        except Exception as exc:  # noqa: BLE001
            components["sqlite_read"] = {"ok": False, "error": "sqlite_unreadable"}

        try:
            from .services import utc_now

            app.state.db.execute(
                "INSERT INTO tm_meta (key, value) VALUES ('health_probe', ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (utc_now(),),
            )
            components["sqlite_write"] = {"ok": True}
        except Exception:  # noqa: BLE001
            components["sqlite_write"] = {"ok": False, "error": "sqlite_unwritable"}

        from .tm_outbox import snapshot_health

        components["snapshot"] = {"ok": True, **snapshot_health(app.state.db)}
        components["snapshot"]["ok"] = not components["snapshot"]["snapshot_degraded"]

        if settings.tm_ingest_secret:
            core = app.state.tm_core
            upstream = core.health() if core is not None else None
            components["tm_core"] = {
                "ok": upstream is not None,
                "role": (upstream or {}).get("role"),
                "hubBuild": (upstream or {}).get("hubBuild"),
                "runtime": (upstream or {}).get("runtime"),
            }
        else:
            components["tm_core"] = {"ok": True, "state": "disabled"}

        ok = all(c.get("ok") for c in components.values())
        return JSONResponse(
            status_code=200 if ok else 503,
            content={"ok": ok, "role": "cloud-hub", "components": components},
        )

    @app.post("/api/v1/sync/push")
    def sync_push(
        payload: SyncPushRequest,
        db: Database = Depends(db_dep),
        binding: WriteBinding = Depends(ingest_auth),
    ) -> dict:
        enforce_device_binding(binding, payload.device.id)
        if len(payload.records) > settings.max_records_per_push:
            raise HTTPException(
                status_code=400,
                detail=f"records 单次最多 {settings.max_records_per_push} 条",
            )
        try:
            return apply_sync_push(
                db, payload, protocol_version=settings.protocol_version
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/usage", dependencies=[Depends(read_auth)])
    def get_usage(
        db: Database = Depends(db_dep),
        start_time: Optional[str] = Query(default=None),
        end_time: Optional[str] = Query(default=None),
        device_id: Optional[str] = Query(default=None),
    ) -> dict:
        try:
            return usage_report(
                db, start_time=start_time, end_time=end_time, device_id=device_id
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/users", dependencies=[Depends(read_auth)])
    def get_users(
        db: Database = Depends(db_dep),
        start_time: Optional[str] = Query(default=None),
        end_time: Optional[str] = Query(default=None),
    ) -> dict:
        try:
            users = list_users(db, start_time=start_time, end_time=end_time)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"users": users, "total": len(users)}

    @app.get("/api/v1/records", dependencies=[Depends(read_auth)])
    def get_records(
        db: Database = Depends(db_dep),
        start_time: Optional[str] = Query(default=None),
        end_time: Optional[str] = Query(default=None),
        user_id: Optional[str] = Query(default=None),
        model_name: Optional[str] = Query(default=None),
        device_id: Optional[str] = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=200),
    ) -> dict:
        try:
            return list_usage_page(
                db,
                start_time=start_time,
                end_time=end_time,
                user_id=user_id,
                model_name=model_name,
                device_id=device_id,
                page=page,
                page_size=page_size,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/devices", dependencies=[Depends(read_auth)])
    def get_devices(db: Database = Depends(db_dep)) -> dict:
        devices = list_devices(db)
        return {"devices": devices, "total": len(devices)}

    frontend_dir: Path = settings.frontend_dir
    if frontend_dir.is_dir():
        live_index = frontend_dir / "index.html"
        demo_index = frontend_dir / "demo.html"
        root_index = demo_index if settings.cm_demo and demo_index.is_file() else live_index

        @app.get("/")
        def index() -> FileResponse:
            if not root_index.is_file():
                raise HTTPException(status_code=404, detail="未找到前端页面")
            return FileResponse(root_index)

        if (settings.cm_demo or settings.serve_demo_route) and demo_index.is_file():
            @app.get("/demo", include_in_schema=False)
            def demo_page() -> FileResponse:
                return FileResponse(demo_index)

        app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

    # 旧的 /tm/ 面板已并入 /（云端用量面板）：301 保留书签兼容
    @app.get("/tm", include_in_schema=False)
    @app.get("/tm/", include_in_schema=False)
    def tm_redirect() -> RedirectResponse:
        return RedirectResponse(url="/", status_code=301)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    return app


_default_app: FastAPI | None = None


def get_default_app() -> FastAPI:
    global _default_app
    if _default_app is None:
        _default_app = create_app()
    return _default_app


class _AppProxy:
    """Lazy ASGI app so tests can call create_app() without a default database."""

    def __getattr__(self, name: str):
        return getattr(get_default_app(), name)

    async def __call__(self, scope, receive, send):
        await get_default_app()(scope, receive, send)


app = _AppProxy()
