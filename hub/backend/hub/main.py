from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
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
from .tm_proxy import bootstrap_tm_layer, build_tm_router


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or load_settings()
    docs_urls = (
        {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}
        if settings.docs_enabled
        else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    )
    app = FastAPI(title="Cloud Monitor 云端 Token 看板", version="2.0.0", **docs_urls)
    app.state.settings = settings
    app.state.db = Database(settings.database_path)

    # token-monitor 官方协议层：协议权威 = tm-core（vendored Node），
    # Python 负责鉴权/校验/限流/快照/面板数据
    tm_core = bootstrap_tm_layer(settings, app.state.db)
    app.include_router(build_tm_router(settings, app.state.db, tm_core))

    # ASGI receive 层 1MiB 实测限流（token-monitor 写入端点）
    app.add_middleware(TmBodyLimitMiddleware)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit():
            if int(content_length) > settings.max_body_bytes:
                return JSONResponse(
                    status_code=413, content={"error": "请求体过大"}
                )
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={"error": "请求体校验失败", "details": jsonable_encoder(exc.errors())},
        )

    @app.on_event("shutdown")
    def close_db() -> None:
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
        return {"ok": True, "role": "cloud-hub", "protocol_version": settings.protocol_version}

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
        index_file = frontend_dir / "index.html"

        @app.get("/")
        def index() -> FileResponse:
            if not index_file.is_file():
                raise HTTPException(status_code=404, detail="未找到前端页面")
            return FileResponse(index_file)

        app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

    # token-monitor 云端面板（独立目录，与上面的 openwebui 记录看板互不影响）
    tm_frontend_dir = settings.frontend_dir.parent / "tm-frontend"
    if tm_frontend_dir.is_dir():
        app.mount(
            "/tm",
            StaticFiles(directory=str(tm_frontend_dir), html=True),
            name="tm-frontend",
        )

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
