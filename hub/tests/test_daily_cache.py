"""Recover daily cache counters from the same retained device/local-day row."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hub.db import Database
from hub import tm_snapshots as snapshots


@pytest.fixture
def db():
    database = Database(":memory:")
    snapshots.ensure_schema(database)
    yield database
    database.close()


def seed(db, *, device="device", day=None, at="12:00", total=100, output=0,
         cache_read=0, cache_write=0, unclassified=0, recorded=None,
         cost=0.0, received=None, all_time=0):
    day = day or datetime.now(timezone.utc).date().isoformat()
    stamp = f"{day}T{at}:00.000Z"
    db.execute(
        """INSERT INTO tm_snapshot_buckets (
            device_id, local_day, bucket_start, today_total, today_output,
            today_cache_read, today_cache_write, today_unclassified,
            today_components_recorded, today_cost, all_time_total,
            server_received_at, device_time_zone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (device, day, stamp, total, output, cache_read, cache_write, unclassified,
         recorded, cost, all_time, received or stamp, "Asia/Tokyo"),
    )
    return day


def only_day(db):
    return snapshots.query_daily_archive(db)["items"][0]


def test_same_day_last_bucket_supplies_every_component_and_cost(db):
    day = seed(db, at="23:55", total=1000, output=50, cache_read=800,
               cache_write=0, recorded=1, cost=1.25)
    # Later insertion/arrival, larger total and larger cache are still an older bucket.
    seed(db, at="23:50", total=2000, output=80, cache_read=1500,
         cache_write=100, recorded=1, cost=3.0, received=f"{day}T23:59:00.000Z")
    archive = only_day(db)
    assert archive["tokens"] == 1000
    assert archive["costUsd"] == 1.25
    assert archive["outputTokens"] == 50
    assert archive["cacheReadTokens"] == 800
    assert archive["cacheWriteTokens"] == 0
    assert archive["unclassifiedTokens"] == 0
    assert archive["tokenComponentsAvailable"] is True
    assert archive["componentsPartial"] is False
    trend = snapshots.trend_by_day(db)[0]
    assert trend["day"] == day
    assert trend["total"] == archive["tokens"]
    for field in ("costUsd", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                  "unclassifiedTokens", "tokenComponentsAvailable", "componentsPartial"):
        assert trend[field] == archive[field]


def test_old_default_zeros_stay_unknown_and_cannot_create_pure_input(db):
    seed(db, total=100)
    item = only_day(db)
    assert item["tokens"] == 100
    assert item["cacheReadTokens"] is None
    assert item["cacheWriteTokens"] is None
    assert item["outputTokens"] is None
    assert item["unclassifiedTokens"] == 100
    assert item["tokenComponentsAvailable"] is False
    assert item["componentsPartial"] is True
    # Existing archive completeness describes its rows/maps, not token classification.
    assert item["complete"] is True


def test_old_positive_counters_survive_but_unproven_zeros_and_input_do_not(db):
    seed(db, total=100, output=10, cache_read=60, unclassified=20)
    item = only_day(db)
    assert item["cacheReadTokens"] == 60
    assert item["outputTokens"] == 10
    assert item["cacheWriteTokens"] is None
    assert item["unclassifiedTokens"] == 30
    assert item["componentsPartial"] is True


def test_each_device_is_classified_before_known_cache_is_aggregated(db):
    seed(db, device="known", total=100, output=10, cache_read=80, recorded=1)
    seed(db, device="unknown", total=200)
    item = only_day(db)
    assert item["deviceCount"] == 2
    assert item["tokens"] == 300
    assert item["cacheReadTokens"] == 80
    assert item["cacheWriteTokens"] == 0
    assert item["outputTokens"] == 10
    assert item["unclassifiedTokens"] == 200
    assert item["cacheReadTokens"] / item["tokens"] == pytest.approx(80 / 300)
    assert item["componentsPartial"] is True
    assert item["tokenComponentsAvailable"] is False


def test_all_unknown_devices_produce_null_cache_not_a_zero_share(db):
    seed(db, device="a", total=100)
    seed(db, device="b", total=200)
    item = only_day(db)
    assert item["cacheReadTokens"] is None
    assert item["cacheWriteTokens"] is None
    assert item["outputTokens"] is None
    assert item["unclassifiedTokens"] == 300


def write(db, today, *, received="2026-09-05T03:02:00.000Z"):
    return snapshots.write_snapshot(
        db, device_id="writer", limits_only=False,
        record={
            "periods": {"today": today},
            "periodWindows": {"today": {"key": "2026-09-05"}, "timeZone": "Asia/Tokyo"},
            "updatedAt": "2026-09-05T03:01:00.000Z", "receivedAt": received,
        },
    )


def test_new_explicit_zero_components_remain_zero_and_marker_updates_with_same_bucket(db, monkeypatch):
    monkeypatch.setattr(snapshots, "_prune_if_due", lambda _: None)
    write(db, {"totalTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
               "cacheWriteTokens": 0, "unclassifiedTokens": 0})
    assert db.fetchone("SELECT today_components_recorded AS recorded FROM tm_snapshot_buckets")["recorded"] == 1
    item = only_day(db)
    assert [item[key] for key in snapshots.COMPONENT_COLUMNS] == [0, 0, 0, 0]
    assert item["tokenComponentsAvailable"] is True
    assert item["componentsPartial"] is False
    # A newer incomplete snapshot must replace the marker along with its counters.
    write(db, {"totalTokens": 100, "cacheReadTokens": 60}, received="2026-09-05T03:03:00.000Z")
    assert db.fetchone("SELECT today_components_recorded AS recorded FROM tm_snapshot_buckets")["recorded"] == 0
    item = only_day(db)
    assert item["cacheReadTokens"] == 60
    assert item["outputTokens"] is None
    assert item["unclassifiedTokens"] == 40
    # An old retry cannot restore its earlier fields or marker.
    write(db, {"totalTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
               "cacheWriteTokens": 0, "unclassifiedTokens": 0}, received="2026-09-05T03:01:30.000Z")
    assert only_day(db) == item


def test_recorded_components_can_still_include_unclassified_usage(db, monkeypatch):
    monkeypatch.setattr(snapshots, "_prune_if_due", lambda _: None)
    write(db, {"totalTokens": 100, "outputTokens": 10, "cacheReadTokens": 60,
               "cacheWriteTokens": 0, "unclassifiedTokens": 30,
               "capabilities": {"tokenComponents": False}})
    assert db.fetchone("SELECT today_components_recorded AS recorded FROM tm_snapshot_buckets")["recorded"] == 1
    item = only_day(db)
    assert item["cacheReadTokens"] == 60
    assert item["cacheWriteTokens"] == 0
    assert item["unclassifiedTokens"] == 30
    assert item["componentsPartial"] is True
    assert item["tokenComponentsAvailable"] is False


@pytest.mark.parametrize("bad", [None, -1, True, 1.5, "10", float("inf")])
def test_invalid_or_missing_counters_never_mark_a_new_row_complete(bad):
    period = {"totalTokens": 100, "outputTokens": 10, "cacheReadTokens": bad,
              "cacheWriteTokens": 0, "unclassifiedTokens": 0}
    assert snapshots._components_recorded(period) == 0


def test_inconsistent_row_does_not_emit_an_impossible_cache_share(db):
    seed(db, total=100, output=10, cache_read=200, recorded=1)
    item = only_day(db)
    assert item["cacheReadTokens"] is None
    assert item["outputTokens"] is None
    assert item["unclassifiedTokens"] == 100
    assert item["componentsPartial"] is True


def test_nullable_schema_upgrade_is_idempotent_and_does_not_backfill_old_rows():
    database = Database(":memory:")
    old_schema = snapshots.SCHEMA.replace("    today_components_recorded INTEGER,\n", "")
    database._conn.executescript(old_schema)
    database.execute("INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start, today_total, today_cache_read) VALUES ('old', '2026-09-01', '2026-09-01T01:00:00.000Z', 100, 60)")
    before = database.fetchone("SELECT * FROM tm_snapshot_buckets")
    snapshots.ensure_schema(database)
    snapshots.ensure_schema(database)
    after = database.fetchone("SELECT * FROM tm_snapshot_buckets")
    assert after.pop("today_components_recorded") is None
    assert after == before
    assert only_day(database)["cacheReadTokens"] == 60
    assert only_day(database)["cacheWriteTokens"] is None
    database.close()


def test_old_daily_anchor_retains_components_and_never_uses_all_time_difference(db):
    day = "2026-08-01"
    seed(db, day=day, at="12:00", total=100, output=10, cache_read=60, recorded=1, all_time=5000)
    seed(db, day=day, at="23:55", total=1000, output=50, cache_read=800, recorded=1, all_time=9000)
    before = only_day(db)
    removed = snapshots.prune_snapshots(db, now=datetime(2026, 9, 5, tzinfo=timezone.utc))
    assert removed == {"full_res": 1, "hard": 0}
    assert only_day(db) == before
    stored = db.fetchone("SELECT today_cache_read, today_components_recorded FROM tm_snapshot_buckets")
    assert stored == {"today_cache_read": 800, "today_components_recorded": 1}
    assert before["tokens"] == 1000


def test_sql_selects_only_requested_days_before_windowing_and_keeps_pagination(db, monkeypatch):
    today = datetime.now(timezone.utc).date()
    for offset in range(40):
        day = (today - timedelta(days=offset)).isoformat()
        seed(db, day=day, total=100 + offset, cache_read=60, recorded=1)
        seed(db, device="other", day=day, total=200, cache_read=160, recorded=1)
    calls = []
    original = db.fetchall
    def capture(sql, params=()):
        calls.append((sql, tuple(params)))
        return original(sql, params)
    monkeypatch.setattr(db, "fetchall", capture)
    page = snapshots.query_daily_archive(db, limit=2)
    assert len(page["items"]) == 2
    assert page["items"][0]["tokens"] == 300
    assert page["items"][0]["cacheReadTokens"] == 220
    assert "LIMIT ?" in calls[0][0]
    assert calls[0][1][-1] == 3
    assert "WHERE local_day IN (?,?)" in calls[1][0]
    assert len(calls[1][1]) == 2
    second = snapshots.query_daily_archive(db, limit=2, cursor=page["next_cursor"])
    assert not {item["day"] for item in page["items"]} & {item["day"] for item in second["items"]}
    calls.clear()
    trend = snapshots.trend_by_day(db, days=2)
    assert len(trend) == 2
    assert trend[-1]["cacheReadTokens"] == 220
    assert trend[0]["day"] < trend[1]["day"]
    assert "local_day >= ?" in calls[0][0]
    assert calls[0][1][-1] == 2
    assert "WHERE local_day IN (?,?)" in calls[1][0]
    assert len(calls[1][1]) == 2
    plan = original("EXPLAIN QUERY PLAN " + calls[1][0], calls[1][1])
    assert any("INDEX" in row["detail"] for row in plan)
