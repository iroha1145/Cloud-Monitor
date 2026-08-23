"""GET /api/v1/tm/history/daily SQL 分页 + 与 activity.daily 共用查询核心。"""

from __future__ import annotations

import datetime as dt
import json

import pytest

from conftest import READ_KEY, TM_SECRET, make_cloud_app, requires_node, widget_style_payload
from hub.db import Database
from hub.tm_overview import activity_report, daily_activity
from hub.tm_snapshots import (
    HARD_RETENTION_DAYS,
    build_distinct_days_query,
    ensure_schema,
    query_daily_archive,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def seed(db, device, day, bucket, total, cost=0.0, clients=None, models=None, tz="", received=None):
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, today_cost, clients_json, models_json, device_time_zone,"
        " server_received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(device_id, local_day, bucket_start) DO UPDATE SET"
        " today_total=excluded.today_total, today_cost=excluded.today_cost,"
        " clients_json=excluded.clients_json, models_json=excluded.models_json,"
        " server_received_at=excluded.server_received_at",
        (
            device,
            day,
            bucket,
            total,
            cost,
            json.dumps(clients or {}),
            json.dumps(models or {}),
            tz,
            received or bucket,
        ),
    )


def test_sql_pagination_not_python_slice(tmp_path):
    db = Database(tmp_path / "h.db")
    ensure_schema(db)
    for i in range(40):
        day = (dt.date(2026, 8, 22) - dt.timedelta(days=i)).isoformat()
        seed(db, "a", day, f"{day}T23:55:00.000Z", 100 + i, clients={"claude": 100 + i})
        seed(db, "a", day, f"{day}T00:05:00.000Z", 1)  # 较早桶，必须丢掉
    page1 = query_daily_archive(db, limit=10)
    assert [x["day"] for x in page1["items"]] == [
        (dt.date(2026, 8, 22) - dt.timedelta(days=i)).isoformat() for i in range(10)
    ]
    assert page1["has_more"] is True
    assert page1["next_cursor"] == page1["items"][-1]["day"]
    assert page1["day_basis"] == "device-local"
    assert page1["items"][0]["tokens"] == 100  # 最后一条 23:55，不是 00:05
    page2 = query_daily_archive(db, cursor=page1["next_cursor"], limit=10)
    days1 = {x["day"] for x in page1["items"]}
    days2 = {x["day"] for x in page2["items"]}
    assert not days1 & days2
    retry = query_daily_archive(db, cursor=page1["next_cursor"], limit=10)
    assert [x["day"] for x in retry["items"]] == [x["day"] for x in page2["items"]]
    db.close()


def test_from_to_and_device_filter(tmp_path):
    db = Database(tmp_path / "h2.db")
    ensure_schema(db)
    seed(db, "tokyo", "2026-08-20", "2026-08-20T15:00:00.000Z", 10, tz="Asia/Tokyo")
    seed(db, "lax", "2026-08-20", "2026-08-20T16:00:00.000Z", 5, tz="America/Los_Angeles")
    seed(db, "tokyo", "2026-08-21", "2026-08-21T15:00:00.000Z", 20, tz="Asia/Tokyo")
    mixed = query_daily_archive(db, from_day="2026-08-20", to_day="2026-08-20")
    assert mixed["mixed_time_zones"] is True
    assert mixed["items"][0]["deviceCount"] == 2
    assert mixed["items"][0]["tokens"] == 15
    one = query_daily_archive(db, device_id="tokyo", from_day="2026-08-20", to_day="2026-08-21")
    assert one["mixed_time_zones"] is False
    assert one["device_time_zone"] == "Asia/Tokyo"
    assert [x["day"] for x in one["items"]] == ["2026-08-21", "2026-08-20"]
    db.close()


def test_corrupt_json_marks_partial_not_500(tmp_path):
    db = Database(tmp_path / "h3.db")
    ensure_schema(db)
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, clients_json, models_json) VALUES ('d','2026-08-01',"
        " '2026-08-01T00:00:00.000Z', 9, '{not-json', '{also-bad')"
    )
    page = query_daily_archive(db, limit=5)
    assert page["partial"] is True
    assert page["items"][0]["complete"] is False
    assert page["items"][0]["tokens"] == 9
    assert any("json" in e["code"] for e in page["partial_errors"])
    db.close()


@requires_node
def test_history_daily_http_contract(cloud):
    db = cloud.app.state.db
    for i in range(5):
        day = (dt.date(2026, 8, 22) - dt.timedelta(days=i)).isoformat()
        seed(
            db,
            "dev-hist",
            day,
            f"{day}T10:00:00.000Z",
            50 * (i + 1),
            cost=1.25,
            clients={"claude": 40, "codex": 10},
            models={"sonnet": 40, "gpt-5": 10},
            tz="Asia/Tokyo",
        )
    assert cloud.get("/api/v1/tm/history/daily").status_code == 401
    assert cloud.get("/api/v1/tm/history/daily", headers=HEADERS).status_code == 401
    resp = cloud.get("/api/v1/tm/history/daily", headers=READ, params={"limit": 2})
    assert resp.status_code == 200, resp.text[:300]
    body = resp.json()
    assert body["schema_version"] == 1
    assert body["day_basis"] == "device-local"
    assert body["retention_days"] == HARD_RETENTION_DAYS
    assert body["has_more"] is True
    assert len(body["items"]) == 2
    assert body["items"][0]["perClient"]["claude"] == 40
    retry = cloud.get(
        "/api/v1/tm/history/daily",
        headers=READ,
        params={"cursor": body["next_cursor"], "limit": 2},
    )
    assert retry.json()["items"][0]["day"] != body["items"][0]["day"]
    bad = cloud.get("/api/v1/tm/history/daily", headers=READ, params={"cursor": "nope"})
    assert bad.status_code == 400


@requires_node
def test_overview_does_not_embed_370_days(cloud):
    db = cloud.app.state.db
    today = dt.date(2026, 8, 22)
    for i in range(120):
        day = (today - dt.timedelta(days=i)).isoformat()
        seed(db, "long", day, f"{day}T23:00:00.000Z", 10)
    data = cloud.get("/api/v1/tm/overview", headers=READ).json()
    daily = data["activity"]["daily"]
    assert len(daily) <= 90
    assert data["features"]["history_daily"] is True
    # sqlite 在 History 失败时仍应给出多日，不只当前一天
    assert len(daily) > 1


def test_history_unavailable_sqlite_still_multiday(tmp_path):
    db = Database(tmp_path / "h4.db")
    ensure_schema(db)
    for i in range(12):
        day = (dt.date(2026, 8, 22) - dt.timedelta(days=i)).isoformat()
        seed(db, "d", day, f"{day}T01:00:00.000Z", 7)
    series = daily_activity(db, history=None, dashboard_tz="Asia/Tokyo")
    assert len(series) > 1
    days = {r["day"] for r in series}
    assert "2026-08-22" in days
    assert "2026-08-11" in days
    db.close()


def test_explain_uses_composite_index(tmp_path):
    db = Database(tmp_path / "plan.db")
    ensure_schema(db)
    seed(db, "d", "2026-08-01", "2026-08-01T00:00:00.000Z", 1)
    sql, params = build_distinct_days_query(cursor="2026-08-23")
    plan = db.fetchall(f"EXPLAIN QUERY PLAN {sql}", (*params, 30))
    detail = " ".join(r["detail"] for r in plan)
    assert "USING INDEX" in detail or "INDEX" in detail, detail
    assert "SCAN tm_snapshot_buckets" not in detail or "USING INDEX" in detail

    sql_dev, params_dev = build_distinct_days_query(device_id="d", cursor="2026-08-23")
    plan_dev = db.fetchall(f"EXPLAIN QUERY PLAN {sql_dev}", (*params_dev, 30))
    detail_dev = " ".join(r["detail"] for r in plan_dev)
    assert "idx_tm_buckets_dev_day_bucket" in detail_dev or "USING INDEX" in detail_dev, detail_dev
    db.close()


def test_scale_100x370_query_plan(tmp_path):
    db = Database(tmp_path / "scale-hist.db")
    ensure_schema(db)
    today = dt.date(2026, 8, 22)
    rows = []
    for d in range(100):
        device = f"s-{d:03d}"
        for off in range(370):
            day = (today - dt.timedelta(days=off)).isoformat()
            rows.append((device, day, f"{day}T23:55:00.000Z", 10 + d, "{}"))
    with db.transaction():
        db.executemany(
            "INSERT OR REPLACE INTO tm_snapshot_buckets"
            " (device_id, local_day, bucket_start, today_total, clients_json)"
            " VALUES (?, ?, ?, ?, ?)",
            rows,
        )
    sql, params = build_distinct_days_query()
    plan = db.fetchall(f"EXPLAIN QUERY PLAN {sql}", (*params, 30))
    detail = " ".join(r["detail"] for r in plan)
    page = query_daily_archive(db, limit=30)
    assert page["has_more"] is True
    assert len(page["items"]) == 30
    assert page["items"][0]["deviceCount"] == 100
    assert "INDEX" in detail, detail
    db.close()
