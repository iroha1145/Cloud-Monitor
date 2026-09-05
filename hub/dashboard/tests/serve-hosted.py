"""Isolated, real FastAPI + official Node hub fixture serving production assets."""
from pathlib import Path
import sys
import tempfile
import uvicorn
from fastapi.testclient import TestClient

HUB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HUB / "tests"))
sys.path.insert(0, str(HUB / "backend"))
from conftest import NodeHub, widget_style_payload, TM_SECRET, API_KEY, READ_KEY
from hub.config import Settings
from hub.main import create_app

with tempfile.TemporaryDirectory(prefix="cm-dashboard-e2e-") as directory:
    root = Path(directory)
    node = NodeHub(root / "node.json")
    try:
        settings = Settings(api_key=API_KEY, access_token=READ_KEY, database_path=root / "hub.sqlite3", frontend_dir=HUB / "frontend", max_records_per_push=500, tm_ingest_secret=TM_SECRET, tm_core_url=node.url, tm_background_enabled=False, provider_status_enabled=False, overview_cache_seconds=0, serve_demo_route=True)
        app = create_app(settings)
        with TestClient(app) as client:
            response = client.post("/api/ingest", headers={"X-Token-Monitor-Secret": TM_SECRET}, json=widget_style_payload("responsive-real-device"))
            assert response.status_code == 200, response.text
        uvicorn.run(create_app(settings), host="127.0.0.1", port=18888, log_level="warning")
    finally:
        node.stop()
