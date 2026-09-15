"""2026-09-15 审计五项：升级状态权限、outbox 替代、RESET_CURSOR。"""
from __future__ import annotations

import json
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
    record_from_payload,
    record_pending,
    replay_pending,
    replayable_count,
    save_normalized,
    supersede_older_pending,
)
from hub.tm_snapshots import ensure_schema as ensure_snapshots
from hub.tm_snapshots import write_snapshot
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


def _usage(
    device: str,
    day: str,
    total: int,
    *,
    cost: float = 0,
    model: str | None = None,
    updated_at: str | None = None,
) -> dict:
    today = {"totalTokens": total, "costUsd": cost}
    if model:
        today["models"] = {model: total}
    return {
        "deviceId": device,
        "updatedAt": updated_at or f"{day}T03:00:00.000Z",
        "periodWindows": {
            "timeZone": "UTC",
            "today": {"key": day},
        },
        "today": today,
    }


def _normalized(payload: dict, received_at: str) -> dict:
    return record_from_payload(payload, received_at)


class UnusedCore:
    def request(self, *_args, **_kwargs):
        raise AssertionError("replay must not call tm-core or read the current device")


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
    yesterday = _usage("dev", "2026-09-14", 900, cost=9, model="model-900")
    today = _usage("dev", "2026-09-15", 100, cost=1, model="model-100")
    try:
        record_pending(db, request_id="day1", device_id="dev", payload=yesterday)
        record_pending(db, request_id="day2", device_id="dev", payload=today)
        save_normalized(db, "day1", _normalized(yesterday, "2026-09-14T08:00:00.000Z"))
        save_normalized(db, "day2", _normalized(today, "2026-09-15T08:00:00.000Z"))
        mark_done(db, "day2", snapshot_written=True)
        written = write_snapshot(
            db,
            device_id="dev",
            record=_normalized(today, "2026-09-15T08:00:00.000Z"),
            incoming=today,
            limits_only=False,
            force_received_at="2026-09-15T08:00:00.000Z",
            ingest_sequence=2,
        )
        assert written is not None

        result = replay_pending(db, UnusedCore())
        assert "stopped_by" not in result
        assert result["superseded"] == 0
        assert result["completed"] == 1
        day1 = db.fetchone(
            "SELECT state, snapshot_written FROM tm_ingest_outbox WHERE request_id='day1'"
        )
        assert day1["state"] == "done"
        assert int(day1["snapshot_written"] or 0) == 1

        rows = {
            row["local_day"]: row
            for row in db.fetchall(
                "SELECT local_day, today_total, today_cost, models_json"
                " FROM tm_snapshot_buckets"
            )
        }
        assert int(rows["2026-09-14"]["today_total"]) == 900
        assert float(rows["2026-09-14"]["today_cost"]) == 9
        assert json.loads(rows["2026-09-14"]["models_json"]) == {"model-900": 900}
        assert int(rows["2026-09-15"]["today_total"]) == 100
        assert float(rows["2026-09-15"]["today_cost"]) == 1
        assert json.loads(rows["2026-09-15"]["models_json"]) == {"model-100": 100}
    finally:
        db.close()


def test_replay_newer_same_second_usage_overwrites_older_snapshot(tmp_path):
    """同一秒内：较早快照带毫秒，较新 pending 被截到整秒，仍须写入 200。"""
    db = Database(tmp_path / "same-second.sqlite3")
    ensure_schema(db)
    ensure_snapshots(db)
    stamp = "2026-09-15T08:33:44.000Z"
    older_snap = "2026-09-15T08:33:44.024Z"
    first = _usage(
        "dev", "2026-09-15", 100, cost=1, model="model-100", updated_at=stamp
    )
    second = _usage(
        "dev", "2026-09-15", 200, cost=2, model="model-200", updated_at=stamp
    )
    try:
        record_pending(db, request_id="a", device_id="dev", payload=first)
        record_pending(db, request_id="b", device_id="dev", payload=second)
        db.execute(
            "UPDATE tm_ingest_outbox SET ingest_sequence=3, received_at=? WHERE request_id='a'",
            (older_snap,),
        )
        db.execute(
            "UPDATE tm_ingest_outbox SET ingest_sequence=4, received_at=? WHERE request_id='b'",
            (stamp,),
        )
        save_normalized(db, "a", _normalized(first, older_snap))
        save_normalized(db, "b", _normalized(second, stamp))
        mark_done(db, "a", snapshot_written=True)
        written = write_snapshot(
            db,
            device_id="dev",
            record=_normalized(first, older_snap),
            incoming=first,
            limits_only=False,
            force_received_at=older_snap,
            ingest_sequence=3,
        )
        assert written is not None
        before = db.fetchone(
            "SELECT today_total, server_received_at, ingest_sequence"
            " FROM tm_snapshot_buckets WHERE device_id='dev'"
        )
        assert int(before["today_total"]) == 100
        assert before["server_received_at"] == older_snap
        assert int(before["ingest_sequence"]) == 3

        result = replay_pending(db, UnusedCore())
        assert result["checked"] == 1
        assert result["completed"] == 1
        assert result["superseded"] == 0
        row = db.fetchone(
            "SELECT state, snapshot_written FROM tm_ingest_outbox WHERE request_id='b'"
        )
        assert row["state"] == "done"
        assert int(row["snapshot_written"] or 0) == 1
        after = db.fetchone(
            "SELECT today_total, today_cost, models_json, ingest_sequence"
            " FROM tm_snapshot_buckets WHERE device_id='dev'"
        )
        assert int(after["today_total"]) == 200
        assert float(after["today_cost"]) == 2
        assert json.loads(after["models_json"]) == {"model-200": 200}
        assert int(after["ingest_sequence"]) == 4
    finally:
        db.close()


def test_ensure_schema_adds_migrated_columns_before_new_index(tmp_path):
    db = Database(tmp_path / "legacy-outbox.sqlite3")
    try:
        db.execute(
            """
            CREATE TABLE tm_ingest_outbox (
                request_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                received_at TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            )
            """
        )
        db.execute(
            "INSERT INTO tm_ingest_outbox (request_id, device_id, payload_json, received_at)"
            " VALUES (?, 'dev', '{}', '2026-09-15T00:00:00.000Z')",
            ("r1",),
        )
        ensure_schema(db)
        names = {row["name"] for row in db.fetchall("PRAGMA table_info(tm_ingest_outbox)")}
        assert {
            "local_day",
            "ingest_sequence",
            "snapshot_written",
            "writes_usage",
            "normalized_json",
        } <= names
        indexes = {row["name"] for row in db.fetchall("PRAGMA index_list(tm_ingest_outbox)")}
        assert "idx_outbox_device_day_seq" in indexes
        row = db.fetchone(
            "SELECT ingest_sequence FROM tm_ingest_outbox WHERE request_id='r1'"
        )
        assert int(row["ingest_sequence"] or 0) >= 1
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
