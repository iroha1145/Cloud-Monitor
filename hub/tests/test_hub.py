from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import READ_KEY, TM_SECRET, make_settings
from hub.config import ConfigError, load_settings
from hub.main import create_app

AUTH = {"Authorization": f"Bearer {TM_SECRET}"}
READ = {"Authorization": f"Bearer {READ_KEY}"}


@pytest.fixture()
def client(tmp_path) -> TestClient:
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as test_client:
        yield test_client


def test_dashboard_time_zone_region_name_is_a_config_error(monkeypatch, tmp_path):
    """装了 tzdata 包时，区域名（如 Asia）会让 ZoneInfo 去打开一个目录、抛 IsADirectoryError；
    仍须给出清晰的配置错误。没装时抛的是 ZoneInfoNotFoundError，所以要打桩，结果才不随环境变化。"""
    from hub import config

    real = config.ZoneInfo
    calls = []

    def region_is_a_directory(key):
        calls.append(key)
        if key == "Asia":
            raise IsADirectoryError(21, "Is a directory", key)
        return real(key)

    monkeypatch.setattr(config, "ZoneInfo", region_is_a_directory)
    monkeypatch.setenv("ACCESS_TOKEN", "b" * 32)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "tz.db"))
    for bad in ("Asia", "Nope/Zone"):
        monkeypatch.setenv("DASHBOARD_TIME_ZONE", bad)
        with pytest.raises(ConfigError, match="DASHBOARD_TIME_ZONE"):
            load_settings()
    assert calls == ["Asia", "Nope/Zone"]  # 桩确实被 load_settings 用到


def test_cors_and_docs_disabled_by_default(client: TestClient):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    resp = client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in resp.headers


def test_docs_enabled_opt_in(tmp_path):
    settings = make_settings(tmp_path, docs_enabled=True)
    client = TestClient(create_app(settings))
    assert client.get("/docs").status_code == 200


def test_shutdown_closes_database(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings)
    with TestClient(app):
        pass
    assert app.state.db._closed


def test_live_root_hides_demo_route(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe)
    with TestClient(create_app(settings)) as client:
        root = client.get("/")
        assert root.status_code == 200
        assert "LIVE-INDEX" in root.text
        assert client.get("/demo").status_code == 404


def test_cm_demo_serves_demo_at_root(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe, cm_demo=True)
    with TestClient(create_app(settings)) as client:
        root = client.get("/")
        assert root.status_code == 200
        assert "DEMO-INDEX" in root.text


def test_serve_demo_route_keeps_live_root(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe, serve_demo_route=True)
    with TestClient(create_app(settings)) as client:
        assert "LIVE-INDEX" in client.get("/").text
        demo = client.get("/demo")
        assert demo.status_code == 200
        assert "DEMO-INDEX" in demo.text
