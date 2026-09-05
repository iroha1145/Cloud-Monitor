"""Adversarial regressions found during the September 2026 full-stack review."""
from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from threading import Event
from urllib.parse import quote

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import TM_SECRET, widget_style_payload
from hub.body_limit import TmBodyLimitMiddleware
from hub.config import ConfigError, Settings, load_settings
from hub.db import Database, record_fingerprint
from hub.main import create_app
from hub.models import SyncPushRequest
from hub.services import apply_sync_push
from hub.tm_outbox import ensure_schema, record_pending, replay_pending
from hub.tm_overview import OverviewCache
from hub.tm_proxy import TmBackground
from hub.tm_snapshots import ensure_schema as ensure_snapshots


def settings(tmp_path, **overrides):
    values = dict(api_key="a" * 32, access_token="b" * 32,
                  database_path=tmp_path / "review.sqlite3", frontend_dir=tmp_path / "frontend",
                  max_records_per_push=500, tm_background_enabled=False)
    return Settings(**(values | overrides))


@pytest.mark.parametrize("token", ["password", "x", "b" * 31])
def test_access_token_must_meet_the_same_strength_policy(monkeypatch, token):
    monkeypatch.setenv("API_KEY", "a" * 32)
    monkeypatch.setenv("ACCESS_TOKEN", token)
    monkeypatch.delenv("ALLOW_SHARED_TOKEN", raising=False)
    with pytest.raises(ConfigError, match="ACCESS_TOKEN"):
        load_settings()


def test_explicit_shared_token_fallback_remains_supported(monkeypatch):
    monkeypatch.setenv("API_KEY", "a" * 32)
    monkeypatch.delenv("ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("ALLOW_SHARED_TOKEN", "true")
    assert load_settings().access_token == "a" * 32


@pytest.mark.parametrize("device_id", ["gpu?backup", "gpu#backup", "gpu/backup", "工作站?备份"])
def test_delete_forwards_exact_device_id_not_a_query_or_fragment(cloud, device_id):
    headers = {"X-Token-Monitor-Secret": TM_SECRET}
    for name in ("gpu", device_id):
        assert cloud.post("/api/ingest", headers=headers, json=widget_style_payload(name)).status_code == 200
    response = cloud.delete("/api/devices/" + quote(device_id, safe=""), headers=headers)
    assert response.status_code == 200, response.text
    names = {device["deviceId"] for device in cloud.get("/api/devices", headers=headers).json()["devices"]}
    assert "gpu" in names
    assert device_id not in names
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets WHERE device_id = ?", (device_id,))["n"] == 0


def test_receive_replay_preserves_disconnect_message():
    async def scenario():
        source = iter([{"type": "http.request", "body": b"{}", "more_body": False}, {"type": "http.disconnect"}])
        seen = []
        async def receive():
            return next(source)
        async def send(_message):
            pass
        async def app(_scope, replay, _send):
            seen.extend([await replay(), await replay()])
        await TmBodyLimitMiddleware(app)({"type": "http", "path": "/api/ingest"}, receive, send)
        assert seen[-1]["type"] == "http.disconnect"
    asyncio.run(scenario())


def test_update_endpoint_has_actual_body_limit_even_before_authentication(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post("/api/v1/system/update", content=b'{"ref":"main","padding":"' + b"x" * 5000 + b'"}', headers={"content-type": "application/json"})
        assert response.status_code == 413
        assert response.json()["error"] == "payload_too_large"


def test_cors_accepts_the_documented_tm_authentication_header(tmp_path):
    with TestClient(create_app(settings(tmp_path, cors_origins=("https://dashboard.example",)))) as client:
        response = client.options("/api/ingest", headers={"Origin": "https://dashboard.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-token-monitor-secret"})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "https://dashboard.example"
        assert client.options("/api/ingest", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"}).status_code == 400


def test_readiness_reports_database_failure_without_crashing(tmp_path, monkeypatch):
    with TestClient(create_app(settings(tmp_path)), raise_server_exceptions=False) as client:
        def unavailable(*_args, **_kwargs):
            raise sqlite3.OperationalError("database unavailable")
        monkeypatch.setattr(client.app.state.db, "fetchone", unavailable)
        response = client.get("/api/v1/health/ready")
        assert response.status_code == 503
        assert response.json()["components"]["snapshot"]["ok"] is False
        assert client.get("/api/v1/health/live").status_code == 200


def test_background_stop_joins_before_resources_can_be_closed(tmp_path):
    # A deterministic fake models a worker whose current HTTP call exceeds 5s.
    class SlowThread:
        def __init__(self):
            self.alive = True
        def is_alive(self):
            return self.alive
        def join(self, timeout=None):
            assert worker._stop.is_set()
            if timeout is None:
                self.alive = False
    worker = TmBackground(settings(tmp_path), None, None)
    thread = SlowThread()
    worker._thread = thread
    worker.stop()
    assert not thread.is_alive(), "shutdown must not close the DB while maintenance is running"


def test_replay_stops_between_requests_and_keeps_remaining_items_pending(tmp_path):
    db = Database(tmp_path / "outbox.sqlite3")
    ensure_schema(db)
    ensure_snapshots(db)
    stop = Event()
    class Core:
        calls = 0
        def request(self, *_args, **_kwargs):
            self.calls += 1
            stop.set()
            return httpx.Response(400, json={"error": "invalid"})
    core = Core()
    try:
        for key in ("one", "two"):
            record_pending(db, request_id=key, device_id=key, payload={"deviceId": key})
        result = replay_pending(db, core, should_stop=stop.is_set)
        assert core.calls == 1
        assert result["stopped_by"] == "shutdown"
        assert db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox WHERE state='pending'")["n"] == 1
    finally:
        db.close()


def test_slow_overview_cannot_repopulate_cache_after_an_ingest():
    cache = OverviewCache(30)
    generation = cache.generation
    cache.invalidate()  # ingestion completes while old overview is still fetching
    cache.put({"total": 1}, generation=generation)
    assert cache.get() is None
    cache.put({"total": 2}, generation=cache.generation)
    assert cache.get() == {"total": 2}


def record(user_id="a|b", nickname="c"):
    return dict(local_id=1, user_id=user_id, nickname=nickname, model_name="model", input_tokens=10, output_tokens=2, created_at="2026-08-01T00:00:00+00:00")


def payload(*records):
    return SyncPushRequest.model_validate({"device": {"id": "dev"}, "source_instance_id": "source", "records": list(records)})


def test_legacy_fingerprint_collision_is_not_sufficient_evidence_of_equality():
    first, second = record(), record("a", "b|c")
    first.pop("local_id")
    second.pop("local_id")
    assert first != second
    assert record_fingerprint(**first) == record_fingerprint(**second)


@pytest.mark.parametrize("same_batch", [True, False])
def test_separator_collision_is_a_conflict_not_a_duplicate(tmp_path, same_batch):
    db = Database(tmp_path / "fingerprint.sqlite3")
    try:
        first, second = record(), record("a", "b|c")
        if same_batch:
            result = apply_sync_push(db, payload(first, second), protocol_version=2)
        else:
            apply_sync_push(db, payload(first), protocol_version=2)
            result = apply_sync_push(db, payload(second), protocol_version=2)
        assert result["conflicts"] == 1
        assert result["duplicates"] == 0
    finally:
        db.close()


def test_records_with_legacy_fingerprints_still_retry_idempotently(tmp_path):
    db = Database(tmp_path / "legacy-hash.sqlite3")
    try:
        item = record()
        apply_sync_push(db, payload(item), protocol_version=2)
        legacy = hashlib.sha256("|".join(str(item[key]) for key in ("user_id", "nickname", "model_name", "input_tokens", "output_tokens", "created_at")).encode()).hexdigest()
        db.execute("UPDATE usage_records SET fingerprint = ?", (legacy,))
        result = apply_sync_push(db, payload(item), protocol_version=2)
        assert result["duplicates"] == 1
        assert result["conflicts"] == 0
    finally:
        db.close()


def test_percent_encoded_device_id_over_real_http(live_stack):
    # Some Starlette TestClient releases unquote URL.path twice. A live ASGI
    # transport verifies a literal percent sign without relying on that helper.
    device_id = "gpu%backup"
    headers = {"X-Token-Monitor-Secret": TM_SECRET}
    with httpx.Client(base_url=live_stack.url, headers=headers, timeout=10) as client:
        for name in ("gpu", device_id):
            assert client.post("/api/ingest", json=widget_style_payload(name)).status_code == 200
        response = client.delete("/api/devices/" + quote(device_id, safe=""))
        assert response.status_code == 200, response.text
        names = {item["deviceId"] for item in client.get("/api/devices").json()["devices"]}
        assert "gpu" in names
        assert device_id not in names


def test_immediate_host_update_status_is_not_overwritten_by_the_gateway(tmp_path, monkeypatch):
    import json
    from hub import tm_update
    directory = tmp_path / "control"
    directory.mkdir()
    service = tm_update.UpdateService(settings(tmp_path, cm_update_dir=directory))
    real_write = tm_update._atomic_write
    def watcher_starts_immediately(path, data):
        real_write(path, data)
        if path.name == "request.json":
            real_write(directory / "status.json", {"id": data["id"], "state": "running", "ref": data["ref"]})
    monkeypatch.setattr(tm_update, "_atomic_write", watcher_starts_immediately)
    assert service.apply("main")["state"] == "running"
    assert json.loads((directory / "status.json").read_text())["state"] == "running"


def test_concurrent_update_submissions_only_publish_one_request(tmp_path, monkeypatch):
    import time
    from concurrent.futures import ThreadPoolExecutor
    from fastapi import HTTPException
    from hub import tm_update
    directory = tmp_path / "control"
    directory.mkdir()
    service = tm_update.UpdateService(settings(tmp_path, cm_update_dir=directory))
    real_write = tm_update._atomic_write
    def slow_write(path, data):
        time.sleep(0.01)
        return real_write(path, data)
    monkeypatch.setattr(tm_update, "_atomic_write", slow_write)
    def submit(_index):
        try:
            return service.apply("main")["state"]
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(submit, range(8)))
    assert results.count("queued") == 1
    assert results.count(409) == 7


def test_failed_update_publication_does_not_leave_a_permanent_queued_state(tmp_path, monkeypatch):
    from fastapi import HTTPException
    from hub import tm_update
    directory = tmp_path / "control"
    directory.mkdir()
    service = tm_update.UpdateService(settings(tmp_path, cm_update_dir=directory))
    real_write = tm_update._atomic_write
    def disk_failure(path, data):
        if path.name == "request.json":
            raise OSError("disk full")
        return real_write(path, data)
    monkeypatch.setattr(tm_update, "_atomic_write", disk_failure)
    with pytest.raises(HTTPException) as error:
        service.apply("main")
    assert error.value.status_code == 503
    assert service.read_job()["state"] == "error"
    assert not (directory / "request.json").exists()
