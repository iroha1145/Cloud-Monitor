from __future__ import annotations

import asyncio
import datetime as dt

import httpx
import pytest
from zoneinfo import ZoneInfo

from hub.db import Database
from hub.tm_outbox import ensure_schema as ensure_outbox, record_pending, replay_pending
from hub.tm_overview import _dashboard_period, activity_report
from hub.tm_provider_status import ProviderStatusService, _observed_key
from hub.tm_proxy import TmCore, UpstreamUnavailable
from hub.tm_snapshots import (
    ensure_schema as ensure_snapshots,
    legacy_device_payloads,
    mark_legacy_reingested,
)


class Response:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self):
        return self._body


class Core:
    def __init__(self, response: Response):
        self.response = response

    def request(self, *_args, **_kwargs):
        return self.response


def db_for(tmp_path, name="edge.sqlite3"):
    db = Database(tmp_path / name)
    ensure_snapshots(db)
    ensure_outbox(db)
    return db


def seed(db, device, day, bucket, total, tz="UTC"):
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, device_time_zone, server_received_at) VALUES (?, ?, ?, ?, ?, ?)",
        (device, day, bucket, total, tz, bucket),
    )


def test_dashboard_period_today_ends_at_next_local_midnight():
    now = dt.datetime(2026, 8, 23, 12, 34, tzinfo=ZoneInfo("Asia/Tokyo"))
    period = _dashboard_period("Asia/Tokyo", now=now)
    assert period["today"]["key"] == "2026-08-23"
    assert period["today"]["endsAt"] == "2026-08-23T15:00:00.000Z"
    assert period["month"]["endsAt"] == "2026-08-31T15:00:00.000Z"


def test_thirty_minute_interval_is_not_treated_as_five_minute_loss(tmp_path):
    db = db_for(tmp_path, "interval.sqlite3")
    day = "2026-08-23"
    seed(db, "slow", day, f"{day}T00:00:00.000Z", 10)
    seed(db, "slow", day, f"{day}T00:30:00.000Z", 20)
    report = activity_report(
        db,
        "UTC",
        now=dt.datetime(2026, 8, 23, 2, 0, tzinfo=dt.timezone.utc),
        sync_intervals={"slow": 30 * 60 * 1000},
    )
    cov = report["coverage"]
    assert cov["attribution_mode"] == "delta"
    assert cov["expected_buckets"] == 2
    assert cov["observed_buckets"] == 2
    assert cov["devices"][0]["expected_interval_ms"] == 30 * 60 * 1000
    db.close()


def test_terminal_4xx_is_rejected_not_replayed_forever(tmp_path):
    db = db_for(tmp_path)
    record_pending(
        db,
        request_id="r1",
        device_id="dev",
        payload={"deviceId": "dev", "today": {"totalTokens": 1}},
    )
    result = replay_pending(db, Core(Response(400)))
    row = db.fetchone("SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='r1'")
    assert result["rejected"] == 1
    assert row["state"] == "rejected"
    assert row["attempts"] == 1
    db.close()


def test_missing_normalized_device_never_writes_zero_snapshot(tmp_path):
    db = db_for(tmp_path)
    record_pending(
        db,
        request_id="r2",
        device_id="dev",
        payload={"deviceId": "dev", "today": {"totalTokens": 1}},
    )
    result = replay_pending(db, Core(Response(200, {"stats": {"devices": []}})))
    row = db.fetchone("SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='r2'")
    count = db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"]
    assert result["failed"] == 1
    assert row["state"] == "pending"
    assert row["attempts"] == 1
    assert count == 0
    db.close()


def test_legacy_marker_is_written_only_after_success(tmp_path):
    db = db_for(tmp_path)
    db.execute("CREATE TABLE tm_devices (device_id TEXT, payload TEXT, last_seen_at TEXT)")
    db.execute(
        "INSERT INTO tm_devices VALUES (?, ?, ?)",
        ("legacy", '{"deviceId":"legacy","today":{"totalTokens":1}}', ""),
    )
    assert len(legacy_device_payloads(db)) == 1
    assert len(legacy_device_payloads(db)) == 1
    mark_legacy_reingested(db)
    assert legacy_device_payloads(db) == []
    db.close()


def test_tmcore_wraps_read_timeout_as_upstream_unavailable():
    class TimeoutClient:
        def request(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("slow")

    core = TmCore("http://tm-core:17321", "secret", TimeoutClient())
    with pytest.raises(UpstreamUnavailable):
        core.request("GET", "/api/stats")


def test_provider_cache_key_includes_observed_aliases():
    assert _observed_key({"openai": ["codex"]}) != _observed_key(
        {"openai": ["openai"]}
    )


def test_provider_full_failure_preserves_last_known_good(monkeypatch):
    import hub.tm_provider_status as module

    clock = [0.0]
    service = ProviderStatusService(cache_seconds=1, monotonic=lambda: clock[0])
    observed = {"openai": ["codex"]}

    async def good(*_args, **_kwargs):
        return ([{"provider": "openai", "status": "operational", "stale": False}], [])

    async def failed(*_args, **_kwargs):
        return ([{"provider": "openai", "status": "unknown", "stale": False}], [{"provider": "openai", "error_code": "timeout"}])

    async def run():
        monkeypatch.setattr(module, "fetch_provider_statuses", good)
        first = await service.snapshot(client=object(), observed=observed)
        assert first["providers"][0]["status"] == "operational"
        clock[0] = 2.0
        monkeypatch.setattr(module, "fetch_provider_statuses", failed)
        await service._do_fetch(object(), observed, _observed_key(observed))
        stale = await service.snapshot(client=object(), observed=observed)
        assert stale["providers"][0]["status"] == "operational"
        assert stale["providers"][0]["stale"] is True

    asyncio.run(run())


def test_quota_resets_at_days_ahead_is_accepted():
    from hub.tm_validate import validate_ingest_payload

    payload = {
        "deviceId": "Mac Mini",
        "updatedAt": "2026-08-23T16:08:11.259Z",
        "today": {"totalTokens": 1},
        "limits": {
            "providers": [
                {
                    "id": "claude",
                    "windows": [
                        {"kind": "session", "resetsAt": "2026-08-23T18:00:00.000Z"},
                        {"kind": "weekly", "resetsAt": "2026-08-28T09:59:59.638Z"},
                    ],
                }
            ]
        },
    }
    assert validate_ingest_payload(payload) is payload
