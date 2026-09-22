from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.staticfiles import StaticFiles as StarletteStaticFiles

from .auth import (
    CodedHTTPException,
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
from .tm_update import UpdateService, build_update_router


def _cache_control_for(path: str) -> str:
    lowered = path.lower()
    if lowered.endswith((".html",)) or lowered in {"/", "/demo", "/index.html"}:
        return "no-store"
    if lowered.endswith("theme-boot.js") or lowered.endswith("manifest.json"):
        return "no-store"
    if "/static/app/assets/" in lowered or lowered.startswith("/static/app/assets/"):
        return "public, max-age=31536000, immutable"
    if lowered.startswith("/api/") or lowered == "/api":
        return "no-store"
    return "no-cache"


class SafeStaticFiles(StarletteStaticFiles):
    async def get_response(self, path: str, scope):
        normalized = path.replace("\\", "/").lstrip("/").lower()
        if (
            normalized == "tests"
            or normalized.startswith("tests/")
            or "/tests/" in normalized
        ):
            from starlette.responses import PlainTextResponse

            return PlainTextResponse("Not Found", status_code=404)
        return await super().get_response(path, scope)


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
            timeout=httpx.Timeout(5.0, read=15.0), limits=httpx.Limits(max_connections=20)
        )
        _app.state.http_sse = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, read=None), limits=httpx.Limits(max_connections=64)
        )
        _app.state.http_provider = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, read=5.0), limits=httpx.Limits(max_connections=20)
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
            await _app.state.http_sse.aclose()
            await _app.state.http_provider.aclose()
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
    overview_router, overview_cache = build_tm_overview_router(settings, app.state.db)
    app.state.overview_cache = overview_cache
    app.include_router(overview_router)
    from .tm_outbox import set_overview_invalidator

    set_overview_invalidator(overview_cache.invalidate)
    app.state.update_service = UpdateService(settings)
    app.include_router(build_update_router(settings, app.state.update_service))

    # ASGI receive 层实测限流：TM 写入端点 1MiB（官方上限），
    # /api/v1/sync/push 为可配置实际字节上限（P1-6，统一覆盖所有写接口）
    app.add_middleware(
        TmBodyLimitMiddleware,
        limits={
            "/api/ingest": 1024 * 1024,
            "/api/subscriptions": 1024 * 1024,
            "/api/v1/sync/push": settings.max_sync_body_bytes,
            "/api/v1/system/update": 4096,
        },
    )

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            # 与路由能力对齐：tm 路由含 PUT /api/subscriptions、DELETE /api/devices/{id}
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-Token-Monitor-Secret"],
        )

    # 安全响应头（P1-8）：所有响应统一附加，不影响静态 UI 加载
    class SecurityAndCacheMiddleware:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope.get("type") != "http":
                await self.app(scope, receive, send)
                return
            path = scope.get("path") or ""

            async def send_with_headers(message):
                if message.get("type") == "http.response.start":
                    headers = list(message.get("headers") or [])
                    names = {k.lower() for k, _ in headers}
                    extras = [
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (
                            b"content-security-policy",
                            b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"
                            b" img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
                            b" base-uri 'none'; form-action 'self'",
                        ),
                    ]
                    status = int(message.get("status") or 0)
                    # H-12：只给 2xx/304 加缓存头，避免 404 被 immutable 锁一年。
                    if (
                        b"cache-control" not in names
                        and (200 <= status < 300 or status == 304)
                    ):
                        extras.append(
                            (b"cache-control", _cache_control_for(path).encode())
                        )
                    for key, value in extras:
                        if key not in names:
                            headers.append((key, value))
                    message = {**message, "headers": headers}
                await send(message)

            await self.app(scope, receive, send_with_headers)

    app.add_middleware(SecurityAndCacheMiddleware)

    @app.exception_handler(CodedHTTPException)
    async def coded_http_error(_request: Request, exc: CodedHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": exc.code,
                "detail": exc.detail,
                "message": exc.detail,
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        # Pydantic errors may retain NaN/Infinity or entire submitted objects in
        # input/ctx. Return only diagnostic metadata, never re-serialize input.
        details = [
            {key: error[key] for key in ("type", "loc", "msg") if key in error}
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=400,
            content={"error": "请求体校验失败", "details": details},
        )

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
        return {
            "ok": True,
            "role": "cloud-hub",
            "protocol_version": settings.protocol_version,
        }

    @app.get("/api/v1/health/live")
    def health_live() -> dict:
        """存活探测：进程可响应即 200。"""
        return {"ok": True, "role": "cloud-hub"}

    @app.get("/api/v1/health/ready")
    def health_ready(request: Request) -> JSONResponse:
        """就绪探测：SQLite 读写、tm-core、快照/outbox 状态。"""
        components: dict[str, dict] = {}

        from .tm_outbox import snapshot_health

        try:
            # Bound the Python mutex as well as external SQLite write-lock
            # contention. A normal SELECT alone cannot prove write readiness.
            with app.state.db.probe_access():
                try:
                    app.state.db.fetchone("SELECT 1 AS one")
                    components["sqlite_read"] = {"ok": True}
                except Exception:
                    components["sqlite_read"] = {"ok": False, "error": "sqlite_unreadable"}
                try:
                    app.state.db.probe_write()
                    components["sqlite_write"] = {"ok": True}
                except Exception:
                    components["sqlite_write"] = {"ok": False, "error": "sqlite_unwritable"}
                try:
                    components["snapshot"] = {"ok": True, **snapshot_health(app.state.db)}
                    components["snapshot"]["ok"] = not components["snapshot"]["snapshot_degraded"]
                except Exception:
                    components["snapshot"] = {"ok": False, "error": "snapshot_unavailable"}
        except Exception:
            for name, error in (
                ("sqlite_read", "sqlite_unreadable"),
                ("sqlite_write", "sqlite_unwritable"),
                ("snapshot", "snapshot_unavailable"),
            ):
                components.setdefault(name, {"ok": False, "error": error})

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
    async def sync_push(
        request: Request,
        db: Database = Depends(db_dep),
        binding: WriteBinding = Depends(ingest_auth),
    ) -> dict:
        try:
            raw = await request.json()
        except (ValueError, UnicodeDecodeError, RecursionError) as exc:
            # json.loads 对深层嵌套抛 RecursionError，仍是客户端正文问题。
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON") from exc
        from pydantic import ValidationError

        from starlette.concurrency import run_in_threadpool

        def _sync_push() -> dict:
            try:
                payload = SyncPushRequest.model_validate(raw)
            except ValidationError as exc:
                details = []
                for error in exc.errors():
                    item = {key: error[key] for key in ("type", "loc", "msg") if key in error}
                    loc = item.get("loc")
                    if isinstance(loc, (list, tuple)) and (not loc or loc[0] != "body"):
                        item["loc"] = ["body", *loc]
                    details.append(item)
                return JSONResponse(
                    status_code=400,
                    content={"error": "请求体校验失败", "details": details},
                )
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

        return await run_in_threadpool(_sync_push)

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
        # The built dashboard is used in release images; source checkouts retain
        # the static fallback until the dashboard has been built.
        page_dir = frontend_dir / "app" if (frontend_dir / "app" / "index.html").is_file() else frontend_dir
        live_index = page_dir / "index.html"
        demo_index = page_dir / "demo.html"
        root_index = demo_index if settings.cm_demo and demo_index.is_file() else live_index

        def _page(path):
            return FileResponse(path, headers={"Cache-Control": "no-cache"})

        @app.api_route("/", methods=["GET", "HEAD"])
        def index() -> FileResponse:
            if not root_index.is_file():
                raise HTTPException(status_code=404, detail="未找到前端页面")
            return _page(root_index)

        if (settings.cm_demo or settings.serve_demo_route) and demo_index.is_file():
            @app.api_route("/demo", methods=["GET", "HEAD"], include_in_schema=False)
            def demo_page() -> FileResponse:
                return _page(demo_index)

        app.mount("/static", SafeStaticFiles(directory=str(frontend_dir)), name="static")

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
