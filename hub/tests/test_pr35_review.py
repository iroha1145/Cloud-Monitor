"""PR #35 复审回归：H-1…H-5、H-9、H-12、L-09、D-4。"""
from __future__ import annotations

import json
import threading
import time

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from hub.auth import CodedHTTPException, require_access_token
from hub.config import Settings
from hub.db import Database
from hub.main import create_app
from hub.tm_outbox import (
    ensure_schema,
    mark_done,
    record_pending,
    record_from_payload,
    save_normalized,
    reject_exhausted_pending,
    replay_pending,
    replayable_count,
    supersede_older_pending,
)
from hub.tm_overview import OverviewCache
from hub.tm_proxy import UpstreamUnavailable
from hub.tm_snapshots import ensure_schema as ensure_snapshots
from hub.tm_update import UpdateService


def settings(tmp_path, **overrides):
    values = dict(
        api_key="a" * 32,
        access_token="b" * 32,
        database_path=tmp_path / "review.sqlite3",
        frontend_dir=tmp_path / "frontend",
        max_records_per_push=500,
        tm_background_enabled=False,
    )
    return Settings(**(values | overrides))


def test_probe_write_does_not_rollback_a_concurrent_writer(tmp_path):
    db = Database(tmp_path / "probe.sqlite3")
    db.execute(
        "CREATE TABLE IF NOT EXISTS probe_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)"
    )
    try:
        errors: list[BaseException] = []

        def writer() -> None:
            try:
                for index in range(200):
                    with db.transaction():
                        db.execute(
                            "INSERT INTO probe_rows (n) VALUES (?)",
                            (index,),
                        )
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def prober() -> None:
            try:
                for _ in range(200):
                    db.probe_write()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=writer), threading.Thread(target=prober)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert errors == []
        count = db.fetchone("SELECT COUNT(*) AS n FROM probe_rows")["n"]
        assert count == 200
    finally:
        db.close()


def test_record_pending_does_not_supersede_before_mark_done(tmp_path):
    db = Database(tmp_path / "outbox.sqlite3")
    ensure_schema(db)
    try:
        record_pending(db, request_id="old", device_id="dev", payload={"deviceId": "dev"})
        record_pending(db, request_id="new", device_id="dev", payload={"deviceId": "dev"})
        # Simulate the two durable acknowledgements returned by tm-core.
        for request_id in ("old", "new"):
            save_normalized(db, request_id, {"deviceId": "dev", "periods": {}})
        assert replayable_count(db) == 2
        mark_done(db, "new")
        supersede_older_pending(db, "dev", "new")
        row = db.fetchone(
            "SELECT state, last_error FROM tm_ingest_outbox WHERE request_id='old'"
        )
        assert row["state"] == "pending"
        assert row["last_error"] is None
        mark_done(db, "new", snapshot_written=True)
        supersede_older_pending(db, "dev", "new")
        row = db.fetchone(
            "SELECT state, last_error FROM tm_ingest_outbox WHERE request_id='old'"
        )
        assert row["state"] == "done"
        assert row["last_error"] == "superseded_by_newer"
    finally:
        db.close()


def test_unavailable_replay_stops_without_burning_attempts(tmp_path):
    db = Database(tmp_path / "replay.sqlite3")
    ensure_schema(db)
    ensure_snapshots(db)
    record_pending(db, request_id="keep", device_id="dev", payload={"deviceId": "dev"})

    class DeadCore:
        def request(self, *_args, **_kwargs):
            raise UpstreamUnavailable("tm-core 不可达")

    try:
        result = replay_pending(db, DeadCore())
        assert "stopped_by" not in result
        assert result["checked"] == 0  # no durable upstream acknowledgement
        row = db.fetchone(
            "SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='keep'"
        )
        assert row["state"] == "pending"
        assert int(row["attempts"] or 0) == 0
    finally:
        db.close()


def test_reject_exhausted_pending_sweeps_zombie_rows(tmp_path):
    db = Database(tmp_path / "zombie.sqlite3")
    ensure_schema(db)
    try:
        record_pending(db, request_id="old", device_id="dev", payload={"deviceId": "dev"})
        db.execute(
            "UPDATE tm_ingest_outbox SET attempts=8 WHERE request_id='old'"
        )
        assert replayable_count(db) == 0
        assert reject_exhausted_pending(db) == 1
        row = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id='old'")
        assert row["state"] == "rejected"
    finally:
        db.close()


def test_overview_put_keeps_newer_stale_result_within_age_cap():
    cache = OverviewCache(2)
    generation = cache.generation
    cache.invalidate()
    cache.put({"total": 1}, generation=generation)
    assert cache.get() is None
    assert cache.get(allow_stale=True) == {"total": 1}
    cache._built_at = time.monotonic() - 10
    assert cache.get(allow_stale=True) is None
    cache.put({"total": 2}, generation=cache.generation)
    assert cache.get() == {"total": 2}


def test_access_token_unconfigured_emits_stable_code(tmp_path):
    class DummyRequest:
        headers = {}

    with pytest.raises(CodedHTTPException) as error:
        require_access_token(DummyRequest(), settings(tmp_path, access_token=""))
    assert error.value.code == "access_token_unconfigured"
    assert error.value.detail == "服务器未配置访问密钥"


def test_cancel_running_update_is_conflict(tmp_path):
    from hub import tm_update

    directory = tmp_path / "control"
    directory.mkdir()
    (directory / "request.json").write_text(
        '{"id":"job1","ref":"main","requested_at":"2026-09-15T00:00:00Z"}',
        encoding="utf-8",
    )
    (directory / "status.json").write_text(
        '{"id":"job1","state":"running","ref":"main","updated_at":"2026-09-15T00:00:01Z"}',
        encoding="utf-8",
    )
    service = UpdateService(settings(tmp_path, cm_update_dir=directory))
    with pytest.raises(HTTPException) as error:
        service.cancel()
    assert error.value.status_code == 409
    assert (directory / "request.json").exists()


def test_missing_hashed_asset_is_not_immutable(tmp_path):
    frontend = tmp_path / "frontend"
    (frontend / "app" / "assets").mkdir(parents=True)
    with TestClient(create_app(settings(tmp_path, frontend_dir=frontend))) as client:
        response = client.get("/static/app/assets/missing-chunk.js")
        assert response.status_code == 404
        cache = response.headers.get("cache-control", "")
        assert "immutable" not in cache


def test_replay_finishes_current_item_then_stops(tmp_path):
    db = Database(tmp_path / "stop.sqlite3")
    ensure_schema(db)
    ensure_snapshots(db)
    checks = {"n": 0}

    def should_stop() -> bool:
        checks["n"] += 1
        return checks["n"] > 1

    class UnusedCore:
        def request(self, *_args, **_kwargs):
            raise AssertionError("replay must not read the current device")

    try:
        record_pending(
            db,
            request_id="one",
            device_id="one",
            payload={
                "deviceId": "one",
                "updatedAt": "2026-09-15T03:00:00.000Z",
                "periodWindows": {"timeZone": "UTC", "today": {"key": "2026-09-15"}},
                "today": {"totalTokens": 1},
            },
        )
        record_pending(
            db,
            request_id="two",
            device_id="two",
            payload={
                "deviceId": "two",
                "updatedAt": "2026-09-15T03:00:00.000Z",
                "periodWindows": {"timeZone": "UTC", "today": {"key": "2026-09-15"}},
                "today": {"totalTokens": 2},
            },
        )
        # These requests were accepted before shutdown interrupted snapshot writes.
        for row in db.fetchall("SELECT request_id, payload_json FROM tm_ingest_outbox"):
            save_normalized(db, row["request_id"], record_from_payload(json.loads(row["payload_json"])))
        result = replay_pending(db, UnusedCore(), should_stop=should_stop)
        assert result["stopped_by"] == "shutdown"
        states = {
            row["request_id"]: row["state"]
            for row in db.fetchall("SELECT request_id, state FROM tm_ingest_outbox")
        }
        assert states["one"] == "done"
        assert states["two"] == "pending"
    finally:
        db.close()
