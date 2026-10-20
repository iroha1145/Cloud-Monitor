"""The application runs with two independent credentials and Token Monitor storage only."""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from conftest import READ_KEY, TM_SECRET, make_cloud_app, make_settings, requires_node, widget_style_payload
from hub.config import ConfigError, load_settings
from hub.main import create_app


@pytest.fixture
def configured_env(monkeypatch, tmp_path):
    for name in ("TENANTS_JSON", "TOKEN_MONITOR_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ACCESS_TOKEN", READ_KEY)
    monkeypatch.setenv("TOKEN_MONITOR_SECRET", TM_SECRET)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "hub.sqlite3"))
    monkeypatch.setenv("FRONTEND_DIR", str(tmp_path / "frontend"))
    monkeypatch.setenv("TM_CORE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("TM_BACKGROUND_ENABLED", "false")


def test_two_credentials_start_without_record_sync_configuration(configured_env):
    settings = load_settings()
    assert settings.access_token == READ_KEY
    assert settings.tm_ingest_secret == TM_SECRET
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/health").json() == {
            "ok": True, "role": "cloud-hub", "token_monitor": "enabled",
        }
        assert client.get("/api/v1/health/live").status_code == 200


@pytest.mark.parametrize("name", ["ACCESS_TOKEN", "TOKEN_MONITOR_SECRET"])
@pytest.mark.parametrize("value", ["password", "short", "x" * 31])
def test_both_credentials_require_strong_values(configured_env, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError, match=name):
        load_settings()


def test_credentials_must_differ(configured_env, monkeypatch):
    monkeypatch.setenv("TOKEN_MONITOR_SECRET", READ_KEY)
    with pytest.raises(ConfigError, match="相同"):
        load_settings()


def test_missing_dashboard_credential_is_rejected(configured_env, monkeypatch):
    monkeypatch.delenv("ACCESS_TOKEN")
    with pytest.raises(ConfigError, match="ACCESS_TOKEN"):
        load_settings()


def test_empty_ingest_secret_keeps_token_monitor_disabled(configured_env, monkeypatch):
    monkeypatch.setenv("TOKEN_MONITOR_SECRET", "")
    with TestClient(create_app(load_settings())) as client:
        assert client.get("/api/v1/health").json()["token_monitor"] == "disabled"
        assert client.get("/api/v1/health/ready").json()["components"]["tm_core"]["state"] == "disabled"
        assert client.post("/api/ingest", json={"deviceId": "x"}).status_code == 404


@pytest.mark.parametrize("token", [None, READ_KEY, TM_SECRET])
@pytest.mark.parametrize("method,path", [
    ("POST", "/api/v1/sync/push"),
    ("GET", "/api/v1/records"),
    ("GET", "/api/v1/usage"),
    ("GET", "/api/v1/users"),
    ("GET", "/api/v1/devices"),
])
def test_record_sync_routes_are_absent(tmp_path, method, path, token):
    with TestClient(create_app(make_settings(tmp_path, docs_enabled=True))) as client:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        assert client.request(method, path, headers=headers).status_code == 404
        assert path not in client.get("/openapi.json").json()["paths"]


def test_fresh_database_only_creates_token_monitor_tables(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as client:
        names = {row["name"] for row in client.app.state.db.fetchall(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        assert {"tm_snapshot_buckets", "tm_ingest_outbox", "tm_meta"} <= names
        assert not names & {"devices", "users", "usage_records"}


@requires_node
@pytest.mark.parametrize("old_version", [0, 2])
def test_existing_record_tables_stay_unchanged_and_tm_still_persists(node_hub, tmp_path, old_version):
    path = tmp_path / "existing.sqlite3"
    with sqlite3.connect(path) as connection:
        # An old record database may predate source/fingerprint columns. None
        # of those retired schemas or indexes should be migrated any more.
        connection.executescript("""
            CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE usage_records(id INTEGER PRIMARY KEY, device_id TEXT, local_id INTEGER);
            CREATE UNIQUE INDEX idx_records_device_local ON usage_records(device_id, local_id);
            INSERT INTO devices VALUES ('historic-device', 'Archived');
            INSERT INTO users VALUES ('historic-user', 'Archived');
            INSERT INTO usage_records VALUES (1, 'historic-device', 7);
        """)
        connection.execute(f"PRAGMA user_version = {old_version}")
        schema_before = connection.execute("SELECT type, name, sql FROM sqlite_master WHERE name IN ('devices','users','usage_records','idx_records_device_local') ORDER BY name").fetchall()
    headers = {"X-Token-Monitor-Secret": TM_SECRET}
    with make_cloud_app(tmp_path, node_hub.url, database_path=path) as client:
        assert client.post("/api/ingest", json=widget_style_payload("retained-tm"), headers={"Authorization": f"Bearer {READ_KEY}"}).status_code == 401
        response = client.post("/api/ingest", json=widget_style_payload("retained-tm"), headers=headers)
        assert response.status_code == 200, response.text
        db = client.app.state.db
        assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets WHERE device_id='retained-tm'")["n"] == 1
        assert db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox WHERE state='done'")["n"] == 1
    with make_cloud_app(tmp_path, node_hub.url, database_path=path) as client:
        assert client.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets WHERE device_id='retained-tm'")["n"] == 1
        overview = client.get("/api/v1/tm/overview", headers={"Authorization": f"Bearer {READ_KEY}"})
        assert overview.status_code == 200
        assert any(row["deviceId"] == "retained-tm" for row in overview.json()["devices"])
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == old_version
        assert connection.execute("SELECT type, name, sql FROM sqlite_master WHERE name IN ('devices','users','usage_records','idx_records_device_local') ORDER BY name").fetchall() == schema_before
        assert connection.execute("SELECT * FROM devices").fetchall() == [("historic-device", "Archived")]
        assert connection.execute("SELECT * FROM users").fetchall() == [("historic-user", "Archived")]
        assert connection.execute("SELECT * FROM usage_records").fetchall() == [(1, "historic-device", 7)]
