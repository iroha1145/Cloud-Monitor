"""快照压缩：按真实时间 ROW_NUMBER，而不是 MAX(id)；截止时间为毫秒 Z。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hub.db import Database
from hub.tm_snapshots import ensure_schema, norm_ts, prune_snapshots, utc_z


def insert(db, device, day, bucket, total, received=None, rowid=None):
    if rowid is None:
        db.execute(
            "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
            " today_total, server_received_at) VALUES (?, ?, ?, ?, ?)",
            (device, day, bucket, total, received or bucket),
        )
        return
    db.execute(
        "INSERT INTO tm_snapshot_buckets (id, device_id, local_day, bucket_start,"
        " today_total, server_received_at) VALUES (?, ?, ?, ?, ?, ?)",
        (rowid, device, day, bucket, total, received or bucket),
    )


def kept(db):
    return db.fetchall(
        "SELECT id, device_id, local_day, bucket_start, today_total, server_received_at"
        " FROM tm_snapshot_buckets ORDER BY id"
    )


def test_out_of_order_insert_keeps_latest_bucket_not_max_id(tmp_path):
    db = Database(tmp_path / "p.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
    day = "2026-08-10"  # 超过 7 天
    insert(db, "d", day, "2026-08-10T23:55:00.000Z", 900, "2026-08-10T23:55:30.000Z", rowid=1)
    insert(db, "d", day, "2026-08-10T23:50:00.000Z", 800, "2026-08-10T23:56:00.000Z", rowid=2)
    removed = prune_snapshots(db, now=now)
    rows = kept(db)
    assert len(rows) == 1
    assert rows[0]["today_total"] == 900
    assert rows[0]["bucket_start"] == "2026-08-10T23:55:00.000Z"
    assert rows[0]["id"] == 1  # 较小 id，但 bucket 更新
    assert removed["full_res"] == 1
    db.close()


def test_late_backfill_does_not_win_against_newer_bucket(tmp_path):
    db = Database(tmp_path / "p2.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
    day = "2026-08-01"
    insert(db, "d", day, "2026-08-01T10:00:00.000Z", 10, "2026-08-01T10:00:01.000Z")
    insert(db, "d", day, "2026-08-01T18:00:00.000Z", 99, "2026-08-01T18:00:01.000Z")
    insert(db, "d", day, "2026-08-01T09:00:00.000Z", 5, "2026-08-20T12:00:00.000Z")  # 延迟补写
    prune_snapshots(db, now=now)
    rows = kept(db)
    assert len(rows) == 1
    assert rows[0]["today_total"] == 99
    db.close()


def test_larger_id_earlier_bucket_discarded(tmp_path):
    db = Database(tmp_path / "p3.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, tzinfo=timezone.utc)
    day = "2026-08-02"
    insert(db, "d", day, "2026-08-02T23:00:00.000Z", 70, rowid=10)
    insert(db, "d", day, "2026-08-02T01:00:00.000Z", 999, rowid=99)
    prune_snapshots(db, now=now)
    rows = kept(db)
    assert rows[0]["today_total"] == 70
    db.close()


def test_same_bucket_later_received_at_wins_via_order(tmp_path):
    """UNIQUE 阻止同桶两行；用几乎同时的两桶验证 received_at/id 次序。"""
    db = Database(tmp_path / "p4.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, tzinfo=timezone.utc)
    day = "2026-08-03"
    insert(db, "d", day, "2026-08-03T12:00:00.000Z", 1, "2026-08-03T12:00:01.000Z")
    insert(db, "d", day, "2026-08-03T12:00:00.001Z", 2, "2026-08-03T12:00:02.000Z")
    prune_snapshots(db, now=now)
    rows = kept(db)
    assert len(rows) == 1
    assert rows[0]["today_total"] == 2
    db.close()


def test_seven_day_boundary(tmp_path):
    db = Database(tmp_path / "p5.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
    cutoff = utc_z(now - timedelta(days=7))
    # 恰好等于 7 天截止：仍是全分辨率，两个桶都留
    insert(db, "d", "2026-08-15", cutoff, 1)
    later = utc_z(now - timedelta(days=7) + timedelta(minutes=5))
    insert(db, "d", "2026-08-15", later, 2)
    # 截止之前：压缩为 1
    insert(db, "d", "2026-08-14", "2026-08-14T01:00:00.000Z", 3)
    insert(db, "d", "2026-08-14", "2026-08-14T02:00:00.000Z", 4)
    prune_snapshots(db, now=now)
    rows = kept(db)
    by_day = {}
    for r in rows:
        by_day.setdefault(r["local_day"], []).append(r)
    assert len(by_day["2026-08-15"]) == 2
    assert len(by_day["2026-08-14"]) == 1
    assert by_day["2026-08-14"][0]["today_total"] == 4
    db.close()


def test_370_day_hard_cutoff(tmp_path):
    db = Database(tmp_path / "p6.db")
    ensure_schema(db)
    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
    hard = utc_z(now - timedelta(days=370))
    insert(db, "d", "2025-08-17", "2025-08-17T00:00:00.000Z", 1)  # older than 370
    insert(db, "d", "2025-08-18", hard, 2)  # 恰好边界，保留
    removed = prune_snapshots(db, now=now)
    rows = kept(db)
    assert all(r["today_total"] != 1 for r in rows)
    assert any(r["today_total"] == 2 for r in rows)
    assert removed["hard"] >= 1
    db.close()


def test_plus00_timestamps_migrated_to_z(tmp_path):
    db = Database(tmp_path / "p7.db")
    ensure_schema(db)
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, server_received_at) VALUES ('d','2026-08-01',"
        " '2026-08-01T12:00:00+00:00', 5, '2026-08-01T12:00:01+00:00')"
    )
    ensure_schema(db)  # 再跑迁移
    row = db.fetchone("SELECT bucket_start, server_received_at FROM tm_snapshot_buckets")
    assert row["bucket_start"].endswith("Z")
    assert "+00:00" not in row["bucket_start"]
    assert row["server_received_at"].endswith("Z")
    assert norm_ts("2026-08-01T12:00:00+00:00") == "2026-08-01T12:00:00.000Z"
    now = datetime(2026, 8, 22, tzinfo=timezone.utc)
    prune_snapshots(db, now=now)
    row = db.fetchone("SELECT bucket_start FROM tm_snapshot_buckets")
    assert row["bucket_start"].endswith("Z")
    db.close()
