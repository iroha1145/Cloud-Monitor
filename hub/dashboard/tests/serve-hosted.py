"""Isolated, real FastAPI + official Node hub fixture serving production assets."""
from pathlib import Path
import sys
import tempfile
import uvicorn
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

HUB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HUB / "tests"))
sys.path.insert(0, str(HUB / "backend"))
from conftest import NodeHub, widget_style_payload, TM_SECRET, API_KEY, READ_KEY
from hub.config import Settings
from hub.main import create_app
from hub.auth import require_access_token
from hub.tm_proxy import UpstreamUnavailable
from hub import tm_forwarding

with tempfile.TemporaryDirectory(prefix="cm-dashboard-e2e-") as directory:
    root = Path(directory)
    node = NodeHub(root / "node.json")
    try:
        settings = Settings(api_key=API_KEY, access_token=READ_KEY, database_path=root / "hub.sqlite3", frontend_dir=HUB / "frontend", max_records_per_push=500, tm_ingest_secret=TM_SECRET, tm_core_url=node.url, tm_background_enabled=False, provider_status_enabled=False, overview_cache_seconds=0, serve_demo_route=True)
        app = create_app(settings)
        with TestClient(app) as client:
            response = client.post("/api/ingest", headers={"X-Token-Monitor-Secret": TM_SECRET}, json=widget_style_payload("responsive-real-device"))
            assert response.status_code == 200, response.text
        # The control route and short retry interval exist only in this isolated
        # test fixture. Production code exposes neither a fault switch nor a
        # writable diagnostics endpoint.
        from dataclasses import replace
        hosted = create_app(replace(settings, tm_background_enabled=True))
        blocked = {"value": False}
        original_request = hosted.state.tm_core.request
        tm_forwarding.RETRY_BASE_SECONDS = .2

        def controlled_request(method, path, **kwargs):
            payload = kwargs.get("json_body") or {}
            if (method == "POST" and path == "/api/ingest"
                    and payload.get("deviceId") == "recovery-real-device" and blocked["value"]):
                raise UpstreamUnavailable("test fixture delivery outage")
            return original_request(method, path, **kwargs)

        hosted.state.tm_core.request = controlled_request

        @hosted.post("/__test/forwarding/{operation}")
        def control_forwarding(operation: str, request: Request):
            require_access_token(request, settings)
            if operation not in {"block", "resume"}:
                raise HTTPException(400, "unknown fixture operation")
            blocked["value"] = operation == "block"
            hosted.state.tm_background.wake()
            return {"blocked": blocked["value"]}

        uvicorn.run(hosted, host="127.0.0.1", port=18888, log_level="warning")
    finally:
        node.stop()
