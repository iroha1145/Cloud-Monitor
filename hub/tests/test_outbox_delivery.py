"""Delivery failures are exercised against the real Node core, with a controlled queue clock."""
from __future__ import annotations

import copy
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
import pytest

from conftest import TM_SECRET, limits_only_payload, make_cloud_app, widget_style_payload
from hub.db import Database
from hub import tm_outbox as outbox, tm_snapshots as snapshots
from hub.tm_forwarding import (
    ForwardAttempt, ForwardingQueue, FORWARD_TTL_SECONDS, INFLIGHT_GRACE_SECONDS,
    MAX_FORWARD_ATTEMPTS, forwarding_queue,
)
from hub.tm_proxy import TmBackground, UpstreamUnavailable

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}


class Clock:
    def __init__(self, value=None):
        current = value or datetime.now(timezone.utc)
        # Persisted queue timestamps have millisecond precision; freeze the
        # test clock at that same precision rather than comparing hidden micros.
        self.value = current.replace(microsecond=(current.microsecond // 1000) * 1000)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)


def usage(device="ordered", total=100, *, day=None):
    payload = widget_style_payload(device, tz="UTC", day=day)
    payload["today"] = {"totalTokens": total, "costUsd": total / 100, "models": {f"model-{total}": total}}
    if day is not None:
        payload["updatedAt"] = f"{day}T12:00:00.000Z"
    return payload


def core_device(core, device):
    return next(row for row in core.request("GET", "/api/devices").json()["devices"] if row["deviceId"] == device)


@pytest.fixture
def database(monkeypatch):
    db = Database(":memory:")
    snapshots.ensure_schema(db)
    outbox.ensure_schema(db)
    monkeypatch.setattr(snapshots, "schedule_prune", lambda db: None)
    yield db
    db.close()


@pytest.fixture
def delivery(cloud, monkeypatch):
    monkeypatch.setattr(snapshots, "schedule_prune", lambda db: None)
    queue = forwarding_queue(cloud.app.state.db, max_pending=1000)
    clock = Clock()
    monkeypatch.setattr(queue, "_clock", clock)
    return cloud, queue, clock, cloud.app.state.tm_core


def test_legacy_unknown_expires_without_snapshot_and_keeps_a_full_audit_window(database):
    db = database
    payload = usage("legacy")
    outbox.record_pending(db, request_id="unknown", device_id="legacy", payload=payload)
    db.execute("UPDATE tm_ingest_outbox SET received_at='2000-01-01T00:00:00+00:00', last_error='old acknowledgement error'")
    outbox.set_snapshot_status(db, success=False, error="old acknowledgement error")
    outbox.ensure_schema(db)  # An upgrade/startup must handle old rows as well.
    row = db.fetchone("SELECT * FROM tm_ingest_outbox")
    assert row["state"] == "expired"
    assert row["terminal_reason"] == "unconfirmed_timeout"
    assert row["last_error"] == "old acknowledgement error"
    assert row["terminal_at"] > "2000-01-01T00:00:00Z"
    assert json.loads(row["payload_json"])["today"] == payload["today"]
    assert outbox.prune_done(db) == 0
    assert outbox.snapshot_health(db)["snapshot_degraded"] is False
    assert outbox.snapshot_health(db)["expired_unconfirmed_outbox"] == 1
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0
    old = snapshots.utc_z(datetime.now(timezone.utc) - timedelta(hours=3))
    db.execute("UPDATE tm_ingest_outbox SET terminal_at=?", (old,))
    assert outbox.prune_done(db) == 1


def test_expiry_does_not_clear_an_unresolved_confirmed_snapshot_error(database):
    db = database
    outbox.record_pending(db, request_id="unknown", device_id="legacy", payload=usage("legacy"))
    outbox.record_pending(db, request_id="confirmed", device_id="current", payload=usage("current"))
    outbox.save_normalized(db, "confirmed", outbox.record_from_payload(usage("current")))
    db.execute("UPDATE tm_ingest_outbox SET received_at='2000-01-01T00:00:00Z', last_error='disk busy' WHERE request_id='unknown'")
    outbox.mark_failed(db, "confirmed", "disk busy")
    outbox.set_snapshot_status(db, success=False, error="disk busy", request_id="confirmed")
    assert outbox.expire_unconfirmed(db) == 1
    state = outbox.snapshot_health(db)
    assert state["snapshot_degraded"] is True
    assert state["pending_outbox"] == 1
    assert state["last_snapshot_error"] == "disk busy"


def test_unconfirmed_reservations_enforce_count_under_concurrent_enqueue(database):
    queue = ForwardingQueue(database, max_pending=3)
    def enqueue(index):
        try:
            return queue.enqueue(usage(f"concurrent-{index}"))
        except outbox.OutboxFullError:
            return None
    with ThreadPoolExecutor(max_workers=12) as workers:
        results = list(workers.map(enqueue, range(12)))
    assert sum(result is not None for result in results) == 3
    assert outbox.pending_count(database) == 3
    assert outbox.replayable_count(database) == 0


def test_full_payload_byte_cap_and_expiry_release_capacity(database):
    clock = Clock()
    queue = ForwardingQueue(database, max_pending=10, max_bytes=800, clock=clock)
    payload = {"deviceId": "bytes-a", "today": {"totalTokens": 1}, "extra": "x" * 500}
    first = queue.enqueue(payload)
    assert queue.enqueue(copy.deepcopy(payload)) == first  # Active retries do not double-reserve.
    with pytest.raises(outbox.OutboxFullError):
        queue.enqueue({**payload, "deviceId": "bytes-b"})
    clock.advance(FORWARD_TTL_SECONDS + 1)
    second = queue.enqueue({**payload, "deviceId": "bytes-b"})
    assert first != second
    old = database.fetchone("SELECT * FROM tm_ingest_outbox WHERE request_id=?", (first,))
    assert old["state"] == "expired"
    assert old["terminal_reason"] == "forward_ttl_expired"
    assert old["forward_payload_json"] is None
    assert old["forward_payload_bytes"] == 0
    assert outbox.prune_done(database) == 0
    assert outbox.snapshot_health(database)["forwarding_bytes"] <= 800


def test_integrity_error_is_terminal_while_locked_error_remains_retryable(database, monkeypatch):
    db = database
    payload = usage("integrity")
    outbox.record_pending(db, request_id="integrity", device_id="integrity", payload=payload)
    outbox.save_normalized(db, "integrity", outbox.record_from_payload(payload))
    db.execute("CREATE TRIGGER constraint_failure BEFORE INSERT ON tm_snapshot_buckets BEGIN SELECT RAISE(ABORT, 'constraint rejected'); END")
    assert outbox.replay_pending(db, None)["rejected"] == 1
    assert db.fetchone("SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='integrity'") == {"state": "rejected", "attempts": 1}
    db.execute("DROP TRIGGER constraint_failure")
    outbox.record_pending(db, request_id="locked", device_id="locked", payload=usage("locked"))
    outbox.save_normalized(db, "locked", outbox.record_from_payload(usage("locked")))
    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(snapshots, "write_snapshot", locked)
    assert outbox.replay_pending(db, None)["failed"] == 1
    assert db.fetchone("SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='locked'") == {"state": "pending", "attempts": 1}


def test_real_core_recovers_the_complete_request_and_releases_payload(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    original = core.request
    online = False
    sent = []
    def transport(method, path, **kwargs):
        if method == "POST":
            sent.append(copy.deepcopy(kwargs["json_body"]))
            if not online:
                raise UpstreamUnavailable("offline")
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    payload = usage("full")
    payload["month"]["sessions"] = {"full-only": {"totalTokens": 7, "model": "model-7"}}
    payload["extension"] = {"preserve": "unchanged"}
    assert cloud.post("/api/ingest", json=payload, headers=HEADERS).status_code == 503
    db = cloud.app.state.db
    row = db.fetchone("SELECT * FROM tm_ingest_outbox WHERE device_id='full'")
    assert json.loads(row["forward_payload_json"]) == payload
    assert "sessions" not in json.loads(row["payload_json"])["month"]
    assert row["normalized_json"] is None
    online = True
    clock.advance(5)
    queue.process_due(core)
    assert sent == [payload, payload]
    row = db.fetchone("SELECT * FROM tm_ingest_outbox WHERE device_id='full'")
    assert row["state"] == "done"
    assert row["forward_payload_json"] is None and row["forward_payload_bytes"] == 0
    assert json.loads(row["normalized_json"])["periods"]["today"]["totalTokens"] == 100
    assert core_device(core, "full")["periods"]["today"]["totalTokens"] == 100
    assert db.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id='full'")["today_total"] == 100


def test_concurrent_later_request_does_not_overtake_the_device_head(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    original = core.request
    entered, release = threading.Event(), threading.Event()
    sent = []
    def transport(method, path, **kwargs):
        if method == "POST":
            sent.append(kwargs["json_body"]["today"]["totalTokens"])
            if len(sent) == 1:
                entered.set()
                assert release.wait(5)
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    with ThreadPoolExecutor(max_workers=1) as worker:
        first = worker.submit(cloud.post, "/api/ingest", json=usage(total=100), headers=HEADERS)
        try:
            assert entered.wait(5)
            second = cloud.post("/api/ingest", json=usage(total=200), headers=HEADERS)
            assert second.status_code == 503
            assert second.json()["error"] == "upstream_queued"
            assert sent == [100]
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200
    queue.process_due(core)
    assert sent == [100, 200]
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 200
    assert cloud.app.state.db.fetchone("SELECT today_total FROM tm_snapshot_buckets")["today_total"] == 200
    assert queue._active == {}


@pytest.mark.parametrize("fault", ["ack-disk", "missing-device", "invalid-json"])
def test_lost_acknowledgement_holds_the_head_before_a_newer_request(delivery, monkeypatch, fault):
    cloud, queue, clock, core = delivery
    original = core.request
    save = outbox.save_normalized
    sent = []
    save_calls = 0
    def store(*args, **kwargs):
        nonlocal save_calls
        save_calls += 1
        if fault == "ack-disk" and save_calls == 1:
            raise sqlite3.OperationalError("ack unavailable")
        return save(*args, **kwargs)
    monkeypatch.setattr(outbox, "save_normalized", store)
    def transport(method, path, **kwargs):
        response = original(method, path, **kwargs)
        if method == "POST":
            sent.append(kwargs["json_body"]["today"]["totalTokens"])
            if len(sent) == 1 and fault == "missing-device":
                return httpx.Response(200, json={"stats": {"devices": [{"deviceId": "someone-else", "periods": {}}]}})
            if len(sent) == 1 and fault == "invalid-json":
                return httpx.Response(200, text="broken JSON")
        return response
    monkeypatch.setattr(core, "request", transport)
    first = cloud.post("/api/ingest", json=usage(total=100), headers=HEADERS)
    assert first.status_code == 503 and first.json()["error"] == "snapshot_ack_unavailable"
    second = cloud.post("/api/ingest", json=usage(total=200), headers=HEADERS)
    assert second.status_code == 503
    assert sent == [100]
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 100
    clock.advance(5)
    queue.process_due(core)
    queue.process_due(core)
    assert sent == [100, 100, 200]
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 200
    rows = cloud.app.state.db.fetchall("SELECT normalized_json, forward_payload_json FROM tm_ingest_outbox ORDER BY ingest_sequence")
    assert [json.loads(row["normalized_json"])["periods"]["today"]["totalTokens"] for row in rows] == [100, 200]
    assert all(row["forward_payload_json"] is None for row in rows)


@pytest.mark.parametrize("later", ["next-day", "limits-only"])
def test_ordered_retry_preserves_daily_and_limits_only_meaning(delivery, monkeypatch, later):
    cloud, queue, clock, core = delivery
    original = core.request
    offline = True
    def transport(method, path, **kwargs):
        if method == "POST" and offline:
            raise UpstreamUnavailable("offline")
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    day = datetime.now(timezone.utc).date()
    old_day = day - timedelta(days=1) if later == "next-day" else day
    first = usage(total=900, day=str(old_day))
    second = usage(total=100, day=str(day)) if later == "next-day" else limits_only_payload("ordered")
    assert cloud.post("/api/ingest", json=first, headers=HEADERS).status_code == 503
    assert cloud.post("/api/ingest", json=second, headers=HEADERS).status_code == 503
    offline = False
    clock.advance(5)
    queue.process_due(core)
    queue.process_due(core)
    rows = cloud.app.state.db.fetchall("SELECT local_day, today_total, today_cost, models_json FROM tm_snapshot_buckets ORDER BY local_day")
    if later == "next-day":
        assert [(r["local_day"], r["today_total"], r["today_cost"]) for r in rows] == [(str(old_day), 900, 9), (str(day), 100, 1)]
        assert [json.loads(r["models_json"]) for r in rows] == [{"model-900": 900}, {"model-100": 100}]
    else:
        assert [(r["local_day"], r["today_total"]) for r in rows] == [(str(day), 900)]
        assert cloud.app.state.db.fetchone("SELECT snapshot_written FROM tm_ingest_outbox ORDER BY ingest_sequence DESC LIMIT 1")["snapshot_written"] == 0


@pytest.mark.parametrize("explicit_window", [False, True])
def test_default_sample_time_is_frozen_across_midnight(delivery, monkeypatch, explicit_window):
    cloud, queue, clock, core = delivery
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    clock.value = datetime.fromisoformat(f"{yesterday}T23:59:58+00:00")
    payload = {"deviceId": "midnight", "today": {"totalTokens": 321}}
    expected_day = yesterday - timedelta(days=1) if explicit_window else yesterday
    if explicit_window:
        payload["periodWindows"] = {"timeZone": "UTC", "today": {"key": str(expected_day)}}
    original = core.request
    offline = True
    def transport(method, path, **kwargs):
        if method == "POST" and offline:
            raise UpstreamUnavailable("midnight outage")
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    assert cloud.post("/api/ingest", json=payload, headers=HEADERS).status_code == 503
    row = cloud.app.state.db.fetchone("SELECT * FROM tm_ingest_outbox WHERE device_id='midnight'")
    frozen = snapshots.utc_z(clock.value)
    assert json.loads(row["forward_payload_json"])["updatedAt"] == frozen
    assert row["received_at"] == frozen
    clock.advance(120)
    offline = False
    queue.process_due(core)
    snap = cloud.app.state.db.fetchone("SELECT * FROM tm_snapshot_buckets WHERE device_id='midnight'")
    assert snap["local_day"] == str(expected_day)
    assert snap["producer_updated_at"] == frozen
    assert snap["server_received_at"] == frozen
    assert snap["bucket_start"] == f"{yesterday}T23:55:00.000Z"
    assert snap["today_total"] == 321


def test_old_complete_envelope_without_timestamp_uses_persisted_receipt(delivery):
    cloud, queue, clock, core = delivery
    payload = {"deviceId": "old-envelope", "today": {"totalTokens": 42}}
    request_id = queue.enqueue(payload)
    receipt = snapshots.utc_z(clock.value - timedelta(days=1))
    cloud.app.state.db.execute(
        "UPDATE tm_ingest_outbox SET forward_payload_json=?, received_at=?, local_day=? WHERE request_id=?",
        (json.dumps(payload), receipt, receipt[:10], request_id),
    )
    queue.process_due(core)
    row = cloud.app.state.db.fetchone("SELECT * FROM tm_snapshot_buckets WHERE device_id='old-envelope'")
    assert row["local_day"] == receipt[:10]
    assert row["producer_updated_at"] == row["server_received_at"] == receipt


@pytest.mark.parametrize("status,kind,delay", [(429, "seconds", 120), (408, "date", 90), (503, "invalid", 5)])
def test_retry_after_is_forwarded_and_controls_background_retry(delivery, monkeypatch, status, kind, delay):
    cloud, queue, clock, core = delivery
    clock.value = clock.value.replace(microsecond=0)
    header = str(delay) if kind == "seconds" else format_datetime(clock.value + timedelta(seconds=delay), usegmt=True) if kind == "date" else "nan"
    original = core.request
    calls = 0
    def transport(method, path, **kwargs):
        nonlocal calls
        if method == "POST":
            calls += 1
            if calls == 1:
                return httpx.Response(status, json={"error": "temporary"}, headers={"Retry-After": header})
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    response = cloud.post("/api/ingest", json=usage(), headers=HEADERS)
    assert response.status_code == status
    assert response.headers["Retry-After"] == header
    clock.advance(delay - 0.1)
    queue.process_due(core)
    assert calls == 1
    clock.advance(0.2)
    queue.process_due(core)
    assert calls == 2
    assert not queue.has_pending()


@pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 422])
def test_deterministic_upstream_rejection_is_not_retried(delivery, monkeypatch, status):
    cloud, queue, clock, core = delivery
    original = core.request
    calls = 0
    def transport(method, path, **kwargs):
        nonlocal calls
        if method == "POST":
            calls += 1
            return httpx.Response(status, json={"error": "rejected"})
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    assert cloud.post("/api/ingest", json=usage(), headers=HEADERS).status_code == status
    clock.advance(60)
    queue.process_due(core)
    assert calls == 1
    row = cloud.app.state.db.fetchone("SELECT * FROM tm_ingest_outbox")
    assert row["state"] == "rejected" and row["terminal_reason"] == "upstream_rejected"
    assert row["forward_payload_json"] is None
    assert row["normalized_json"] is None
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0


def test_restart_restores_the_durable_forwarding_queue(node_hub, tmp_path, monkeypatch):
    monkeypatch.setattr(snapshots, "schedule_prune", lambda db: None)
    clock = Clock()
    payload = usage("restart")
    with make_cloud_app(tmp_path, node_hub.url) as cloud:
        core = cloud.app.state.tm_core
        queue = forwarding_queue(cloud.app.state.db, max_pending=1000)
        queue._clock = clock
        original = core.request
        def offline(method, path, **kwargs):
            if method == "POST":
                raise UpstreamUnavailable("restart outage")
            return original(method, path, **kwargs)
        monkeypatch.setattr(core, "request", offline)
        assert cloud.post("/api/ingest", json=payload, headers=HEADERS).status_code == 503
    clock.advance(5)
    with make_cloud_app(tmp_path, node_hub.url) as cloud:
        queue = forwarding_queue(cloud.app.state.db, max_pending=1000)
        queue._clock = clock
        queue.process_due(cloud.app.state.tm_core)
        assert not queue.has_pending()
        assert cloud.app.state.db.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id='restart'")["today_total"] == 100
        duplicate = cloud.post("/api/ingest", json=payload, headers=HEADERS)
        assert duplicate.status_code == 200 and duplicate.json()["deduplicated"] is True
        assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 1


def test_crash_lease_prevents_newer_request_overtaking_unknown_inflight(delivery):
    cloud, queue, clock, core = delivery
    first = queue.enqueue(usage(total=100))
    queue.enqueue(usage(total=200))
    cloud.app.state.db.execute(
        "UPDATE tm_ingest_outbox SET forward_attempts=1, forward_inflight_until=? WHERE request_id=?",
        (snapshots.utc_z(clock.value + timedelta(seconds=INFLIGHT_GRACE_SECONDS)), first),
    )
    # A new coordinator has no process-memory ownership, as after a crash.
    restarted = ForwardingQueue(cloud.app.state.db, clock=clock)
    assert restarted.process_due(core)["processed"] == 0
    assert core.request("GET", "/api/devices").json()["devices"] == []
    clock.advance(INFLIGHT_GRACE_SECONDS + 1)
    restarted.process_due(core)
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 100
    restarted.process_due(core)
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 200


def test_retry_attempt_budget_terminates_without_losing_diagnostic_evidence(database):
    clock = Clock()
    queue = ForwardingQueue(database, clock=clock)
    request_id = queue.enqueue(usage())
    class UnavailableCore:
        calls = 0
        def request(self, *args, **kwargs):
            self.calls += 1
            return httpx.Response(503, json={"error": "maintenance"})
    core = UnavailableCore()
    for _ in range(MAX_FORWARD_ATTEMPTS):
        result = queue.process_device(core, "ordered")
        clock.advance(result.retry_after)
    assert core.calls == MAX_FORWARD_ATTEMPTS
    assert not queue.has_pending()
    row = database.fetchone("SELECT * FROM tm_ingest_outbox WHERE request_id=?", (request_id,))
    assert row["state"] == "expired" and row["terminal_reason"] == "forward_attempts_exhausted"
    assert "maintenance" in row["last_error"]
    assert row["forward_payload_json"] is None and row["forward_payload_bytes"] == 0
    assert outbox.prune_done(database) == 0
    assert outbox.snapshot_health(database)["snapshot_degraded"] is False


def test_delete_blocks_new_queue_rows_and_prevents_background_resurrection(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    queue.enqueue(usage("delete-race"))
    original = core.request
    entered, release = threading.Event(), threading.Event()
    posted = []
    def transport(method, path, **kwargs):
        if method == "POST":
            posted.append(kwargs["json_body"])
        if method == "DELETE":
            entered.set()
            assert release.wait(5)
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    with ThreadPoolExecutor(max_workers=1) as worker:
        deletion = worker.submit(cloud.delete, "/api/devices/delete-race", headers=HEADERS)
        try:
            assert entered.wait(5)
            response = cloud.post("/api/ingest", json=usage("delete-race", 200), headers=HEADERS)
            assert response.status_code == 503 and response.json()["error"] == "device_busy"
            queue.process_due(core)
            assert posted == []
            assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 1
        finally:
            release.set()
        assert deletion.result(timeout=5).status_code == 200
    queue.process_due(core)
    assert posted == [] and queue._active == {}
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 0
    assert core.request("GET", "/api/devices").json()["devices"] == []


def test_legacy_migration_never_overwrites_an_existing_core_device(delivery):
    cloud, queue, clock, core = delivery
    assert cloud.post("/api/ingest", json=usage("legacy-new", 200), headers=HEADERS).status_code == 200
    db = cloud.app.state.db
    db.execute("CREATE TABLE tm_devices (device_id TEXT, payload TEXT, last_seen_at TEXT)")
    db.execute("INSERT INTO tm_devices VALUES (?, ?, '')", ("legacy-new", json.dumps(usage("legacy-new", 100))))
    db.execute("DELETE FROM tm_meta WHERE key='legacy_reingested'")
    worker = TmBackground(cloud.app.state.settings, db, core)
    assert worker._bootstrap() is True
    assert core_device(core, "legacy-new")["periods"]["today"]["totalTokens"] == 200


def test_client_retry_after_background_acceptance_cannot_roll_back_newer_data(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    original = core.request
    offline = True
    sent = []
    def transport(method, path, **kwargs):
        if method == "POST":
            sent.append(kwargs["json_body"]["today"]["totalTokens"])
            if offline:
                raise UpstreamUnavailable("outage")
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    older = usage(total=100)
    newer = usage(total=200)
    newer["updatedAt"] = snapshots.utc_z(datetime.fromisoformat(older["updatedAt"].replace("Z", "+00:00")) + timedelta(milliseconds=1))
    assert cloud.post("/api/ingest", json=older, headers=HEADERS).status_code == 503
    assert cloud.post("/api/ingest", json=copy.deepcopy(older), headers=HEADERS).status_code == 503
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 1
    assert cloud.post("/api/ingest", json=newer, headers=HEADERS).status_code == 503
    offline = False
    clock.advance(5)
    queue.process_due(core)
    queue.process_due(core)
    before = list(sent)
    retried = cloud.post("/api/ingest", json=json.loads(json.dumps(older, sort_keys=True)), headers=HEADERS)
    assert retried.status_code == 200 and retried.json()["deduplicated"] is True
    assert sent == before == [100, 100, 200]
    assert core_device(core, "ordered")["periods"]["today"]["totalTokens"] == 200
    assert cloud.app.state.db.fetchone("SELECT today_total FROM tm_snapshot_buckets")["today_total"] == 200
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 2


def test_unstamped_heartbeats_merge_only_while_active_and_on_the_same_receipt_day(delivery):
    cloud, queue, clock, core = delivery
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    clock.value = datetime.fromisoformat(f"{yesterday}T23:59:58+00:00")
    payload = {"deviceId": "heartbeat", "today": {"totalTokens": 5}}
    first = queue.enqueue(payload)
    assert queue.enqueue(payload) == first
    clock.advance(10)
    second = queue.enqueue(payload)
    assert second != first
    queue.process_due(core)
    queue.process_due(core)
    third = queue.enqueue(payload)
    assert third not in (first, second)
    queue.process_due(core)
    rows = cloud.app.state.db.fetchall("SELECT state FROM tm_ingest_outbox WHERE device_id='heartbeat'")
    assert [row["state"] for row in rows] == ["done", "done", "done"]


def test_background_ack_between_enqueue_and_frontend_dispatch_returns_confirmed_result(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    enqueue = queue.enqueue
    def enqueue_then_background(payload):
        request_id = enqueue(payload)
        queue.process_due(core)
        return request_id
    monkeypatch.setattr(queue, "enqueue", enqueue_then_background)
    response = cloud.post("/api/ingest", json=usage(), headers=HEADERS)
    assert response.status_code == 200 and response.json()["deduplicated"] is True
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 1
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 1


def boundary_payload(device="boundary", *, day=None):
    payload = {"deviceId": device, "today": {"totalTokens": 777}, "pad": ""}
    if day is not None:
        payload["periodWindows"] = {
            "timeZone": "UTC",
            "today": {"key": str(day), "endsAt": f"{day + timedelta(days=1)}T00:00:00.000Z"},
        }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    payload["pad"] = "x" * (1024 * 1024 - len(raw))
    assert len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()) == 1024 * 1024
    return payload


def test_one_mebibyte_unstamped_request_preserves_every_input_field(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    original = core.request
    sent = []
    def transport(method, path, **kwargs):
        if method == "POST":
            sent.append(copy.deepcopy(kwargs["json_body"]))
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    payload = boundary_payload()
    response = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert sent == [payload]
    assert "updatedAt" not in sent[0]
    row = cloud.app.state.db.fetchone("SELECT * FROM tm_snapshot_buckets WHERE device_id='boundary'")
    assert row["today_total"] == 777
    assert row["producer_updated_at"] == row["server_received_at"] == snapshots.utc_z(clock.value)


@pytest.mark.parametrize("explicit_window", [False, True])
def test_full_unstamped_body_is_not_relabelled_as_today_after_midnight(delivery, monkeypatch, explicit_window):
    cloud, queue, clock, core = delivery
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    clock.value = datetime.fromisoformat(f"{yesterday}T23:59:58+00:00")
    original = core.request
    offline = True
    posted = []
    def transport(method, path, **kwargs):
        if method == "POST":
            posted.append(copy.deepcopy(kwargs["json_body"]))
            if offline:
                raise UpstreamUnavailable("midnight outage")
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    payload = boundary_payload(day=yesterday if explicit_window else None)
    assert cloud.post("/api/ingest", json=payload, headers=HEADERS).status_code == 503
    offline = False
    clock.advance(120)
    queue.process_due(core)
    row = cloud.app.state.db.fetchone("SELECT * FROM tm_ingest_outbox WHERE device_id='boundary'")
    if explicit_window:
        assert posted == [payload, payload]
        assert row["state"] == "done"
        snap = cloud.app.state.db.fetchone("SELECT * FROM tm_snapshot_buckets WHERE device_id='boundary'")
        assert snap["local_day"] == str(yesterday)
        assert snap["server_received_at"] == snap["producer_updated_at"] == f"{yesterday}T23:59:58.000Z"
        assert core_device(core, "boundary")["periodWindows"]["today"]["key"] == str(yesterday)
    else:
        assert posted == [payload]
        assert row["state"] == "expired"
        assert row["terminal_reason"] == "forward_sample_time_missing_across_day"
        assert row["normalized_json"] is None and row["forward_payload_json"] is None
        assert outbox.snapshot_health(cloud.app.state.db)["last_forward_terminal_reason"] == "forward_sample_time_missing_across_day"
        assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0


def test_delayed_head_does_not_starve_another_due_device_or_get_overtaken(delivery):
    cloud, queue, clock, core = delivery
    first = queue.enqueue(usage("sleeping", 100))
    queue.enqueue(usage("sleeping", 200))
    queue.enqueue(usage("ready", 300))
    cloud.app.state.db.execute(
        "UPDATE tm_ingest_outbox SET forward_next_at=? WHERE request_id=?",
        (snapshots.utc_z(clock.value + timedelta(seconds=120)), first),
    )
    assert queue.process_due(core, max_items=1)["processed"] == 1
    devices = core.request("GET", "/api/devices").json()["devices"]
    assert [(row["deviceId"], row["periods"]["today"]["totalTokens"]) for row in devices] == [("ready", 300)]
    assert queue.next_delay(300) == pytest.approx(120)
    assert cloud.app.state.db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox WHERE device_id='sleeping' AND normalized_json IS NULL")["n"] == 2


def test_explicit_offset_sample_time_retains_its_instant_in_utc(delivery):
    cloud, queue, clock, core = delivery
    payload = usage("offset-time")
    producer = clock.value.astimezone(timezone(timedelta(hours=9)))
    payload["updatedAt"] = producer.isoformat(timespec="milliseconds")
    assert cloud.post("/api/ingest", json=payload, headers=HEADERS).status_code == 200
    row = cloud.app.state.db.fetchone("SELECT producer_updated_at FROM tm_snapshot_buckets WHERE device_id='offset-time'")
    assert row["producer_updated_at"] == snapshots.utc_z(producer)


def test_background_shutdown_finishes_the_current_ack_and_leaves_later_input_queued(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    first = queue.enqueue(usage(total=100))
    second = queue.enqueue(usage(total=200))
    original = core.request
    entered, release = threading.Event(), threading.Event()
    sent = []
    def transport(method, path, **kwargs):
        if method == "POST":
            sent.append(kwargs["json_body"]["today"]["totalTokens"])
            entered.set()
            assert release.wait(5)
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    background = TmBackground(cloud.app.state.settings, cloud.app.state.db, core)
    background.start()
    try:
        assert entered.wait(5)
        with ThreadPoolExecutor(max_workers=1) as worker:
            stopped = worker.submit(background.stop)
            try:
                assert background._stop.wait(5)
                assert not stopped.done()
            finally:
                release.set()
            stopped.result(timeout=5)
    finally:
        release.set()
        background.stop()
    assert sent == [100]
    db = cloud.app.state.db
    assert db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id=?", (first,))["state"] == "done"
    assert db.fetchone("SELECT state, normalized_json FROM tm_ingest_outbox WHERE request_id=?", (second,)) == {"state": "pending", "normalized_json": None}
    assert queue._active == {}


def test_legacy_migration_serializes_with_newly_queued_foreground_input(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    db = cloud.app.state.db
    db.execute("CREATE TABLE tm_devices (device_id TEXT, payload TEXT, last_seen_at TEXT)")
    db.execute("INSERT INTO tm_devices VALUES (?, ?, '')", ("legacy-race", json.dumps(usage("legacy-race", 100))))
    db.execute("DELETE FROM tm_meta WHERE key='legacy_reingested'")
    original = core.request
    entered, release = threading.Event(), threading.Event()
    sent = []
    def transport(method, path, **kwargs):
        if method == "GET" and path == "/api/devices":
            entered.set()
            assert release.wait(5)
        if method == "POST":
            sent.append(kwargs["json_body"]["today"]["totalTokens"])
        return original(method, path, **kwargs)
    monkeypatch.setattr(core, "request", transport)
    background = TmBackground(cloud.app.state.settings, db, core)
    with ThreadPoolExecutor(max_workers=1) as worker:
        migration = worker.submit(background._bootstrap)
        try:
            assert entered.wait(5)
            response = cloud.post("/api/ingest", json=usage("legacy-race", 200), headers=HEADERS)
            assert response.status_code == 503 and response.json()["error"] == "upstream_queued"
        finally:
            release.set()
        assert migration.result(timeout=5) is True
    queue.process_due(core)
    assert sent == [100, 200]
    assert core_device(core, "legacy-race")["periods"]["today"]["totalTokens"] == 200


@pytest.mark.parametrize("delete_first", [True, False], ids=["delete-before-replay-write", "replay-write-before-delete"])
def test_confirmed_replay_and_delete_are_serialized(delivery, monkeypatch, delete_first):
    cloud, queue, clock, core = delivery
    db = cloud.app.state.db
    payload = usage("confirmed-delete", 100)
    request_id = queue.enqueue(payload)
    row = db.fetchone("SELECT * FROM tm_ingest_outbox WHERE request_id=?", (request_id,))
    response = core.request("POST", "/api/ingest", json_body=payload)
    assert response.status_code == 200
    record = next(r for r in response.json()["stats"]["devices"] if r["deviceId"] == "confirmed-delete")
    queue._save_acknowledgement(row, record, payload)  # Durable ACK, crash before snapshot.
    selected, release, deleted_upstream = threading.Event(), threading.Event(), threading.Event()
    if delete_first:
        fetchall = db.fetchall
        def pause_after_batch_fetch(sql, params=()):
            rows = fetchall(sql, params)
            if "ORDER BY ingest_sequence ASC, received_at ASC" in sql:
                selected.set()
                assert release.wait(5)
            return rows
        monkeypatch.setattr(db, "fetchall", pause_after_batch_fetch)
    else:
        write = snapshots.write_snapshot
        def pause_inside_write_transaction(*args, **kwargs):
            selected.set()
            assert release.wait(5)
            return write(*args, **kwargs)
        monkeypatch.setattr(snapshots, "write_snapshot", pause_inside_write_transaction)
        request = core.request
        def observe_delete(method, path, **kwargs):
            result = request(method, path, **kwargs)
            if method == "DELETE":
                deleted_upstream.set()
            return result
        monkeypatch.setattr(core, "request", observe_delete)
    with ThreadPoolExecutor(max_workers=2) as workers:
        replay = workers.submit(outbox.replay_pending, db, None)
        try:
            assert selected.wait(5)
            deletion = workers.submit(cloud.delete, "/api/devices/confirmed-delete", headers=HEADERS)
            if delete_first:
                assert deletion.result(timeout=5).status_code == 200
            else:
                assert deleted_upstream.wait(5)
                assert not deletion.done()  # Local purge waits for replay's DB transaction.
        finally:
            release.set()
        stats = replay.result(timeout=5)
        assert deletion.result(timeout=5).status_code == 200
    assert stats["completed"] == (0 if delete_first else 1)
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 0
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0
    assert core.request("GET", "/api/devices").json()["devices"] == []


def test_deleted_legacy_device_is_not_restored_after_an_incomplete_migration(delivery, monkeypatch):
    cloud, queue, clock, core = delivery
    assert cloud.post("/api/ingest", json=usage("legacy-a", 200), headers=HEADERS).status_code == 200
    db = cloud.app.state.db
    db.execute("CREATE TABLE tm_devices (device_id TEXT, payload TEXT, last_seen_at TEXT)")
    for device, total in (("legacy-a", 100), ("legacy-b", 50)):
        db.execute("INSERT INTO tm_devices VALUES (?, ?, '')", (device, json.dumps(usage(device, total))))
    db.execute("DELETE FROM tm_meta WHERE key='legacy_reingested'")
    request = core.request
    block_b = True
    def unavailable_b(method, path, **kwargs):
        if method == "POST" and block_b and kwargs["json_body"]["deviceId"] == "legacy-b":
            return httpx.Response(503, json={"error": "temporary migration outage"})
        return request(method, path, **kwargs)
    monkeypatch.setattr(core, "request", unavailable_b)
    background = TmBackground(cloud.app.state.settings, db, core)
    assert background._bootstrap() is False
    assert db.fetchone("SELECT value FROM tm_meta WHERE key='legacy_reingested'") is None
    assert cloud.delete("/api/devices/legacy-a", headers=HEADERS).status_code == 200
    block_b = False
    assert background._bootstrap() is True
    devices = core.request("GET", "/api/devices").json()["devices"]
    assert [(record["deviceId"], record["periods"]["today"]["totalTokens"]) for record in devices] == [("legacy-b", 50)]
    assert db.fetchone("SELECT payload FROM tm_devices WHERE device_id='legacy-a'") is not None
    assert snapshots.legacy_device_deleted(db, "legacy-a") is True
    # The persistent marker blocks migration only, not a legitimate new upload.
    assert cloud.post("/api/ingest", json=usage("legacy-a", 300), headers=HEADERS).status_code == 200
    assert core_device(core, "legacy-a")["periods"]["today"]["totalTokens"] == 300


def test_deleted_legacy_device_is_skipped_even_after_batch_prefetch(delivery, monkeypatch):
    import hub.tm_proxy as proxy
    cloud, queue, clock, core = delivery
    assert cloud.post("/api/ingest", json=usage("prefetched", 200), headers=HEADERS).status_code == 200
    db = cloud.app.state.db
    db.execute("CREATE TABLE tm_devices (device_id TEXT, payload TEXT, last_seen_at TEXT)")
    db.execute("INSERT INTO tm_devices VALUES (?, ?, '')", ("prefetched", json.dumps(usage("prefetched", 100))))
    db.execute("DELETE FROM tm_meta WHERE key='legacy_reingested'")
    original = proxy.legacy_device_payloads
    fetched, release = threading.Event(), threading.Event()
    def pause_after_legacy_fetch(database):
        payloads = original(database)
        assert [payload["deviceId"] for payload in payloads] == ["prefetched"]
        fetched.set()
        assert release.wait(5)
        return payloads
    monkeypatch.setattr(proxy, "legacy_device_payloads", pause_after_legacy_fetch)
    background = TmBackground(cloud.app.state.settings, db, core)
    with ThreadPoolExecutor(max_workers=1) as workers:
        migration = workers.submit(background._bootstrap)
        try:
            assert fetched.wait(5)
            assert cloud.delete("/api/devices/prefetched", headers=HEADERS).status_code == 200
        finally:
            release.set()
        assert migration.result(timeout=5) is True
    assert core.request("GET", "/api/devices").json()["devices"] == []
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox")["n"] == 0
    assert db.fetchone("SELECT payload FROM tm_devices WHERE device_id='prefetched'") is not None



@pytest.mark.parametrize("value", [123, ["invalid"], {"invalid": "container"}, True, None])
def test_forwarding_window_helpers_handle_non_string_and_non_mapping_values(value):
    from hub.tm_forwarding import _explicit_core_day, _parse_stamp, _receipt_day
    assert _parse_stamp(value) is None
    assert _explicit_core_day({"periodWindows": {"today": value}}) is False
    assert _explicit_core_day({"periodWindows": value}) is False
    assert _receipt_day({"periodWindows": value}, datetime(2026, 9, 19, tzinfo=timezone.utc)) == "2026-09-19"


def test_full_queued_body_with_numeric_window_end_cannot_block_other_devices(database):
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    clock = Clock(datetime.fromisoformat(f"{yesterday}T23:59:58+00:00"))
    queue = ForwardingQueue(database, clock=clock)
    payload = {
        "deviceId": "numeric-window", "today": {"totalTokens": 777},
        "periodWindows": {"timeZone": "UTC", "today": {"key": str(yesterday), "endsAt": 123}},
        "pad": "",
    }
    size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
    payload["pad"] = "x" * (1024 * 1024 - size)
    assert len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()) == 1024 * 1024
    ambiguous = queue.enqueue(payload)  # Existing input contract accepts numeric endsAt.
    assert database.fetchone("SELECT forward_payload_bytes FROM tm_ingest_outbox WHERE request_id=?", (ambiguous,))["forward_payload_bytes"] == 1024 * 1024
    clock.advance(120)
    queue.enqueue(usage("ready-after-invalid", 200))
    class Core:
        def __init__(self):
            self.calls = []
        def request(self, method, path, *, json_body):
            self.calls.append(json_body["deviceId"])
            record = outbox.record_from_payload(json_body, snapshots.utc_z(clock.value))
            return httpx.Response(200, json={"stats": {"devices": [record]}})
    core = Core()
    assert queue.process_due(core, max_items=2)["processed"] == 2
    assert core.calls == ["ready-after-invalid"]
    expired = database.fetchone("SELECT state, terminal_reason FROM tm_ingest_outbox WHERE request_id=?", (ambiguous,))
    assert expired == {"state": "expired", "terminal_reason": "forward_sample_time_missing_across_day"}
    assert database.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id='ready-after-invalid'")["today_total"] == 200
    assert not queue.has_pending()
    assert queue.next_delay(300) == 300
