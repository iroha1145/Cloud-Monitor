"""activity 覆盖率（逐设备求和、钳制 0-100）与 hourly 仪表盘日过滤。"""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from hub.db import Database
from hub.tm_overview import activity_report, daily_activity
from hub.tm_snapshots import ensure_schema, utc_z


def seed(db, device, day, bucket, total, tz="", received=None):
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, device_time_zone, server_received_at) VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(device_id, local_day, bucket_start) DO UPDATE SET"
        " today_total=excluded.today_total, server_received_at=excluded.server_received_at",
        (device, day, bucket, total, tz, received or bucket),
    )


def _db(tmp_path, name="a.db"):
    db = Database(tmp_path / name)
    ensure_schema(db)
    return db


def test_single_device_contiguous_not_low_coverage(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    tz = "UTC"
    now = dt.datetime(2026, 8, 23, 1, 0, tzinfo=dt.timezone.utc)
    for i, total in enumerate((100, 150, 180)):
        stamp = f"{day}T00:{i*5:02d}:00.000Z"
        seed(db, "one", day, stamp, total, tz=tz)
    report = activity_report(db, "UTC", now=now)
    cov = report["coverage"]
    assert cov["attribution_mode"] == "delta"
    assert cov["coverage_percent"] == 100.0
    assert cov["expected_buckets"] == 3
    assert cov["observed_buckets"] == 3
    db.close()


def test_two_devices_same_buckets_coverage_not_200(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 2, 0, tzinfo=dt.timezone.utc)
    for device in ("a", "b"):
        for i, total in enumerate((10, 20, 30)):
            seed(db, device, day, f"{day}T00:{i*5:02d}:00.000Z", total, tz="UTC")
    report = activity_report(db, "UTC", now=now)
    cov = report["coverage"]
    assert cov["observed_buckets"] == 6
    assert cov["expected_buckets"] == 6
    assert cov["coverage_percent"] == 100.0
    assert cov["coverage_percent"] <= 100.0
    db.close()


def test_two_devices_different_spans(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 4, 0, tzinfo=dt.timezone.utc)
    seed(db, "short", day, f"{day}T00:00:00.000Z", 10, tz="UTC")
    seed(db, "short", day, f"{day}T00:05:00.000Z", 20, tz="UTC")
    seed(db, "long", day, f"{day}T00:00:00.000Z", 1, tz="UTC")
    seed(db, "long", day, f"{day}T00:10:00.000Z", 2, tz="UTC")  # gap of 2 slots? 00:00 to 00:10 = 2 slots, GAP_BUCKETS=2, >2 is gap. 2 is not > 2.
    report = activity_report(db, "UTC", now=now)
    cov = report["coverage"]
    # short: expected 2; long: 00:00..00:10 = 3 slots expected, observed 2
    assert cov["observed_buckets"] == 4
    assert cov["expected_buckets"] == 2 + 3
    assert 0 <= cov["coverage_percent"] <= 100
    db.close()


def test_coverage_never_exceeds_100(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 3, 0, tzinfo=dt.timezone.utc)
    for d in range(5):
        for i in range(3):
            seed(db, f"d{d}", day, f"{day}T01:{i*5:02d}:00.000Z", 10 * (i + 1), tz="UTC")
    percent = activity_report(db, "UTC", now=now)["coverage"]["coverage_percent"]
    assert percent <= 100.0
    db.close()


def test_noon_first_seen_is_low_coverage(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 14, 0, tzinfo=dt.timezone.utc)
    seed(db, "late", day, f"{day}T12:00:00.000Z", 1000, tz="UTC")
    cov = activity_report(db, "UTC", now=now)["coverage"]
    assert cov["attribution_mode"] == "delta-low-coverage"
    assert cov["first_sample_at"] == "2026-08-23T12:00:00.000Z"
    seed(db, "late", day, f"{day}T12:30:00.000Z", 1500, tz="UTC")
    cov = activity_report(db, "UTC", now=now)["coverage"]
    assert cov["expected_buckets"] == 7
    assert cov["observed_buckets"] == 2
    assert cov["coverage_percent"] == round(2 / 7 * 100, 1)
    db.close()


def test_long_gap_low_coverage(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 6, 0, tzinfo=dt.timezone.utc)
    seed(db, "g", day, f"{day}T00:00:00.000Z", 10, tz="UTC")
    seed(db, "g", day, f"{day}T03:00:00.000Z", 20, tz="UTC")
    cov = activity_report(db, "UTC", now=now)["coverage"]
    assert cov["devices"][0]["gap_count"] >= 1
    assert cov["attribution_mode"] == "delta-low-coverage"
    db.close()


def test_cumulative_reset_mode(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 1, 0, tzinfo=dt.timezone.utc)
    seed(db, "r", day, f"{day}T00:00:00.000Z", 500, tz="UTC")
    seed(db, "r", day, f"{day}T00:05:00.000Z", 100, tz="UTC")  # 回退
    cov = activity_report(db, "UTC", now=now)["coverage"]
    assert cov["attribution_mode"] == "delta-with-reset"
    assert cov["devices"][0]["reset_count"] == 1
    db.close()


def test_thirty_minute_upload_interval(tmp_path):
    db = _db(tmp_path)
    day = "2026-08-23"
    now = dt.datetime(2026, 8, 23, 2, 0, tzinfo=dt.timezone.utc)
    seed(db, "s", day, f"{day}T00:00:00.000Z", 10, tz="UTC")
    seed(db, "s", day, f"{day}T00:30:00.000Z", 20, tz="UTC")
    cov = activity_report(db, "UTC", now=now)["coverage"]
    assert cov["attribution_mode"] == "delta-low-coverage"
    assert cov["expected_buckets"] == 7
    db.close()


def test_hourly_filters_other_dashboard_days(tmp_path):
    db = _db(tmp_path)
    # 仪表盘 Tokyo；UTC 15:00 = 次日 00:00，不得并入今日 00 点
    now = dt.datetime(2026, 8, 23, 12, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
    seed(db, "tky", "2026-08-23", "2026-08-23T01:00:00.000Z", 100, tz="Asia/Tokyo")  # 10:00 JST today
    seed(db, "tky", "2026-08-22", "2026-08-22T15:00:00.000Z", 50, tz="Asia/Tokyo")  # 00:00 JST 08-23? 15:00Z 08-22 = 00:00 JST 08-23. That's TODAY.
    seed(db, "tky", "2026-08-23", "2026-08-23T15:00:00.000Z", 200, tz="Asia/Tokyo")  # 00:00 JST 08-24 tomorrow
    report = activity_report(db, "Asia/Tokyo", now=now)
    assert report["hourly_day"] == "2026-08-23"
    assert report["time_zone"] == "Asia/Tokyo"
    assert report["hourly_today"]["day"] == "2026-08-23"
    hourly = {h["hour"]: h["total"] for h in report["hourly"]}
    assert hourly.get(10) == 100  # 01:00Z = 10:00 JST, 新本地日首桶
    assert hourly.get(0) == 50  # 08-22 15:00Z = 今日 00:00 JST
    # 08-23 15:00Z = 08-24 00:00 JST → 不得并入今日 hour=0
    assert sum(hourly.values()) == 150
    tomorrow = {d["day"]: d["total"] for d in report["daily"]}
    assert tomorrow.get("2026-08-24") == 100
    db.close()


def test_dst_23_and_25_hour_totals_conserved(tmp_path):
    db = _db(tmp_path)
    # America/Los_Angeles 2026-03-08 春令时 23h；2026-11-01 秋令时 25h
    spring_now = dt.datetime(2026, 3, 8, 20, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
    for i, hour_utc in enumerate((8, 9, 10, 11)):  # 00-03 local after/around spring
        seed(
            db,
            "dst",
            "2026-03-08",
            f"2026-03-08T{hour_utc:02d}:00:00.000Z",
            100 * (i + 1),
            tz="America/Los_Angeles",
        )
    spring = activity_report(db, "America/Los_Angeles", now=spring_now)
    assert sum(h["total"] for h in spring["hourly"]) == 400

    fall_now = dt.datetime(2026, 11, 1, 20, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
    for i, hour_utc in enumerate((7, 8, 9, 10)):
        seed(
            db,
            "dst2",
            "2026-11-01",
            f"2026-11-01T{hour_utc:02d}:00:00.000Z",
            50 * (i + 1),
            tz="America/Los_Angeles",
        )
    fall = activity_report(db, "America/Los_Angeles", now=fall_now)
    assert sum(h["total"] for h in fall["hourly"]) == 200
    db.close()


def test_activity_daily_uses_archive_beyond_latest_day(tmp_path):
    db = _db(tmp_path)
    now = dt.datetime(2026, 8, 23, 12, 0, tzinfo=dt.timezone.utc)
    for i in range(20):
        day = (dt.date(2026, 8, 23) - dt.timedelta(days=i)).isoformat()
        seed(db, "hist", day, f"{day}T01:00:00.000Z", 8, tz="UTC")
    report = activity_report(db, "UTC", now=now)
    assert len(report["daily"]) > 1
    days = {r["day"] for r in report["daily"]}
    assert "2026-08-23" in days
    assert "2026-08-10" in days
    db.close()
