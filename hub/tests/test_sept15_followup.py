"""2026-09-15 审计五项：升级状态权限、outbox 替代、RESET_CURSOR。"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from hub.config import Settings
from hub.db import Database
from hub.tm_outbox import (
    can_supersede,
    ensure_schema,
    mark_done,
    record_pending,
    replay_pending,
    replayable_count,
    supersede_older_pending,
)
from hub.tm_snapshots import ensure_schema as ensure_snapshots
from hub.tm_update import UpdateService
from hub.tm_validate import is_limits_only_update


def settings(tmp_path, **overrides):
    values = dict(
        api_key="a" * 32,
        access_token="b" * 32,
        database_path=tmp_path / "followup.sqlite3",
        frontend_dir=tmp_path / "frontend",
        max_records_per_push=500,
        tm_background_enabled=False,
    )
    return Settings(**(values | overrides))


def _usage(device: str, day: str, total: int) -> dict:
    return {
        "deviceId": device,
        "updatedAt": f"{day}T03:00:00.000Z",
        "periodWindows": {
            "timeZone": "UTC",
            "today": {"key": day},
        },
        "today": {"totalTokens": total},
    }


def _limits(device: str, day: str) -> dict:
    return {
        "deviceId": device,
        "updatedAt": f"{day}T04:00:00.000Z",
        "periodWindows": {
            "timeZone": "UTC",
            "today": {"key": day},
        },
        "limits": {"providers": [{"provider": "claude"}]},
    }


def test_unreadable_status_is_not_queued_and_cancel_conflicts(tmp_path, monkeypatch):
    directory = tmp_path / "control"
    directory.mkdir()
    (directory / "request.json").write_text(
        '{"id":"job1","ref":"main","requested_at":"2026-09-15T00:00:00Z"}',
        encoding="utf-8",
    )
    status = directory / "status.json"
    status.write_text(
        '{"id":"job1","state":"running","ref":"main","updated_at":"2026-09-15T00:00:01Z"}',
        encoding="utf-8",
    )
    status.chmod(0o000)
    if os.access(status, os.R_OK):
        original = Path.read_text

        def blocked(self, *args, **kwargs):
            if self.resolve() == status.resolve():
                raise PermissionError("[Errno 13] Permission denied: status.json")
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", blocked)
    service = UpdateService(settings(tmp_path, cm_update_dir=directory))
    try:
        job = service.read_job()
        assert job["state"] != "queued"
        assert job.get("status_unreadable") is True
        with pytest.raises(HTTPException) as error:
            service.cancel()
        assert error.value.status_code == 409
        assert (directory / "request.json").exists()
    finally:
        status.chmod(0o644)


def test_limits_only_done_does_not_supersede_usage_pending(tmp_path):
    db = Database(tmp_path / "limits.sqlite3")
    ensure_schema(db)
    try:
        usage = _usage("dev", "2026-09-15", 100)
        limits = _limits("dev", "2026-09-15")
        assert not is_limits_only_update(usage)
        assert is_limits_only_update(limits)
        record_pending(db, request_id="usage", device_id="dev", payload=usage)
        record_pending(db, request_id="limits", device_id="dev", payload=limits)
        mark_done(db, "limits", snapshot_written=False)
        assert supersede_older_pending(db, "dev", "limits") == 0
        row = db.fetchone(
            "SELECT state, writes_usage FROM tm_ingest_outbox WHERE request_id='usage'"
        )
        assert row["state"] == "pending"
        assert int(row["writes_usage"]) == 1
        assert replayable_count(db) == 1
    finally:
        db.close()


def test_earlier_snapshot_cannot_supersede_later_pending(tmp_path):
    db = Database(tmp_path / "order.sqlite3")
    ensure_schema(db)
    try:
        record_pending(
            db, request_id="a", device_id="dev", payload=_usage("dev", "2026-09-15", 100)
        )
        record_pending(
            db, request_id="b", device_id="dev", payload=_usage("dev", "2026-09-15", 200)
        )
        mark_done(db, "a", snapshot_written=True)
        assert supersede_older_pending(db, "dev", "a") == 0
        row = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id='b'")
        assert row["state"] == "pending"
    finally:
        db.close()


def test_later_same_day_snapshot_supersedes_older_usage(tmp_path):
    db = Database(tmp_path / "same-day.sqlite3")
    ensure_schema(db)
    try:
        record_pending(
            db, request_id="a", device_id="dev", payload=_usage("dev", "2026-09-15", 100)
        )
        record_pending(
            db, request_id="b", device_id="dev", payload=_usage("dev", "2026-09-15", 200)
        )
        mark_done(db, "b", snapshot_written=True)
        assert supersede_older_pending(db, "dev", "b") == 1
        row = db.fetchone(
            "SELECT state, last_error FROM tm_ingest_outbox WHERE request_id='a'"
        )
        assert row["state"] == "done"
        assert row["last_error"] == "superseded_by_newer"
    finally:
        db.close()


def test_other_day_pending_is_not_superseded(tmp_path):
    db = Database(tmp_path / "other-day.sqlite3")
    ensure_schema(db)
    try:
        record_pending(
            db, request_id="old-day", device_id="dev",
            payload=_usage("dev", "2026-09-14", 50),
        )
        record_pending(
            db, request_id="new-day", device_id="dev",
            payload=_usage("dev", "2026-09-15", 80),
        )
        mark_done(db, "new-day", snapshot_written=True)
        assert supersede_older_pending(db, "dev", "new-day") == 0
        row = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id='old-day'")
        assert row["state"] == "pending"
    finally:
        db.close()


def test_can_supersede_requires_written_snapshot_and_sequence():
    old = {
        "device_id": "dev",
        "local_day": "2026-09-15",
        "ingest_sequence": 1,
        "writes_usage": 1,
        "snapshot_written": 0,
    }
    saved = {
        "device_id": "dev",
        "local_day": "2026-09-15",
        "ingest_sequence": 2,
        "writes_usage": 1,
        "snapshot_written": 0,
    }
    assert can_supersede(old, saved) is False
    saved["snapshot_written"] = 1
    assert can_supersede(old, saved) is True
    saved["writes_usage"] = 0
    assert can_supersede(old, saved) is False


def test_replay_does_not_skip_older_day_when_newer_day_has_snapshot(tmp_path):
    db = Database(tmp_path / "replay-day.sqlite3")
    ensure_schema(db)
    ensure_snapshots(db)
    try:
        record_pending(
            db, request_id="day1", device_id="dev",
            payload=_usage("dev", "2026-09-14", 10),
        )
        record_pending(
            db, request_id="day2", device_id="dev",
            payload=_usage("dev", "2026-09-15", 20),
        )
        mark_done(db, "day2", snapshot_written=True)
        db.execute(
            "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
            " today_total, server_received_at) VALUES (?,?,?,?,?)",
            ("dev", "2026-09-15", "2026-09-15T03:00:00.000Z", 20, "2026-09-15T03:00:00.000Z"),
        )

        class DeadCore:
            def request(self, *_args, **_kwargs):
                from hub.tm_proxy import UpstreamUnavailable

                raise UpstreamUnavailable("tm-core 不可达")

        result = replay_pending(db, DeadCore())
        assert result["stopped_by"] == "upstream_unavailable"
        row = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id='day1'")
        assert row["state"] == "pending"
        assert result["superseded"] == 0
    finally:
        db.close()


def test_compose_and_scripts_pass_reset_cursor_and_runtime_mode():
    root = Path(__file__).resolve().parents[2]
    compose = (root / "agent" / "docker-compose.yml").read_text(encoding="utf-8")
    assert "RESET_CURSOR: ${RESET_CURSOR:-false}" in compose
    example = (root / "agent" / ".env.example").read_text(encoding="utf-8")
    assert "RESET_CURSOR=false" in example
    assert "改回 false" in example or "关闭" in example
    install = (root / "install.sh").read_text(encoding="utf-8")
    update = (root / "hub" / "scripts" / "self-update.sh").read_text(encoding="utf-8")
    assert 'install -d -o root -g 999 -m 0750' in install
    assert 'install -d -o root -g 999 -m 0750' in update
    assert "chmod 700 /run/cloud-monitor" not in install
    assert 'chmod 700 "$RUNTIME"' not in update
    assert "os.fchmod(fd, 0o640)" in update
    assert "os.fchown(fd, 0, 999)" in update
