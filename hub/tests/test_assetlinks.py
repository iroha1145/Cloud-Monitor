"""TWA 域名校验路由（/.well-known/assetlinks.json）行为。"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from conftest import API_KEY, READ_KEY, TM_SECRET  # noqa: F401
from hub.config import Settings
from hub.main import create_app


def _app(tmp_path: Path, assetlinks: Path | None) -> TestClient:
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=tmp_path,
        max_records_per_push=500,
        tm_ingest_secret=TM_SECRET,
        tm_core_url="http://127.0.0.1:1",
        tm_background_enabled=False,
        assetlinks_file=assetlinks,
    )
    return TestClient(create_app(settings))


def test_assetlinks_missing_is_404(tmp_path: Path):
    client = _app(tmp_path, tmp_path / "absent.json")
    resp = client.get("/.well-known/assetlinks.json")
    assert resp.status_code == 404


def test_assetlinks_served_as_json(tmp_path: Path):
    target = tmp_path / "assetlinks.json"
    target.write_text('[{"relation": ["delegate_permission/common.handle_all_urls"]}]', "utf-8")
    client = _app(tmp_path, target)
    resp = client.get("/.well-known/assetlinks.json")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()[0]["relation"] == ["delegate_permission/common.handle_all_urls"]
    assert resp.headers.get("cache-control") == "no-store"


def test_assetlinks_file_can_appear_without_restart(tmp_path: Path):
    target = tmp_path / "assetlinks.json"
    client = _app(tmp_path, target)
    assert client.get("/.well-known/assetlinks.json").status_code == 404
    target.write_text("[]", "utf-8")
    assert client.get("/.well-known/assetlinks.json").status_code == 200
