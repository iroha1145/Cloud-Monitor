from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import require_access_token, require_api_key
from .config import Settings, load_settings
from .db import Database
from .services import (
    apply_sync_push,
    list_devices,
    list_usage_records,
    list_users,
    paginate_records,
    usage_report,
)


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(title="Cloud Monitor 云端 Token 看板", version="1.0.0")
    app.state.settings = settings
    app.state.db = Database(settings.database_path)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def settings_dep() -> Settings:
        return app.state.settings

    def db_dep() -> Database:
        return app.state.db

    def ingest_auth(request: Request, cfg: Settings = Depends(settings_dep)) -> None:
        require_api_key(request, cfg)

    def read_auth(request: Request, cfg: Settings = Depends(settings_dep)) -> None:
        require_access_token(request, cfg)

    @app.get("/api/v1/health")
    def health() -> dict:
        return {"ok": True, "role": "cloud-hub"}

    @app.post("/api/v1/sync/push", dependencies=[Depends(ingest_auth)])
    def sync_push(payload: dict, db: Database = Depends(db_dep)) -> dict:
        try:
            return apply_sync_push(
                db, payload, max_records=app.state.settings.max_records_per_push
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
            raise HTTPException(status_code=400, detail="时间格式无效") from exc

    @app.get("/api/v1/users", dependencies=[Depends(read_auth)])
    def get_users(
        db: Database = Depends(db_dep),
        start_time: Optional[str] = Query(default=None),
        end_time: Optional[str] = Query(default=None),
    ) -> dict:
        try:
            users = list_users(db, start_time=start_time, end_time=end_time)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="时间格式无效") from exc
        return {"users": users, "total": len(users)}

    @app.get("/api/v1/records", dependencies=[Depends(read_auth)])
    def get_records(
        db: Database = Depends(db_dep),
        start_time: Optional[str] = Query(default=None),
        end_time: Optional[str] = Query(default=None),
        user_id: Optional[str] = Query(default=None),
        model_name: Optional[str] = Query(default=None),
        device_id: Optional[str] = Query(default=None),
        page: int = Query(default=1),
        page_size: int = Query(default=20),
    ) -> dict:
        try:
            rows = list_usage_records(
                db,
                start_time=start_time,
                end_time=end_time,
                user_id=user_id,
                model_name=model_name,
                device_id=device_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="时间格式无效") from exc
        return paginate_records(rows, page=page, page_size=page_size)

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
