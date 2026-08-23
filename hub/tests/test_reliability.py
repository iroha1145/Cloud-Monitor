"""P0/P1 修复项的故障路径测试（v2，基线 83 项之上新增）。

覆盖：outbox 崩溃恢复/并发/背压、健康检查（disabled/live/ready/tm-core
退出/延迟启动）、活动时间口径（跨时区/覆盖率/夏令时/仪表盘时区）、
会话跨设备主键、overview partial、预验证器补齐、三写接口真实正文上限、
EXPLAIN 索引命中、乱序快照压缩、等价规模生成器。
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from conftest import (
    API_KEY,
    READ_KEY,
    TM_SECRET,
    _now_iso,
    agent_style_payload,
    limits_only_payload,
    make_cloud_app,
    official_payload,
    requires_node,
    widget_style_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def ingest(cloud, payload):
    resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert resp.status_code == 200, resp.text[:300]
    return resp.json()


def overview(cloud):
    resp = cloud.get("/api/v1/tm/overview", headers=READ)
    assert resp.status_code == 200, resp.text[:300]
    return resp.json()


def seed_bucket(db, device, day, bucket, total, received=None):
    db.execute(
        "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start,"
        " today_total, server_received_at) VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT(device_id, local_day, bucket_start) DO UPDATE SET"
        " today_total=excluded.today_total, server_received_at=excluded.server_received_at",
        (device, day, bucket, total, received or bucket),
    )


# ================================================================ P0-1 outbox


@requires_node
def test_snapshot_failure_not_silently_lost_then_replayed(node_hub, tmp_path, monkeypatch):
    """快照写入异常 → 200 但健康暴露 degraded；恢复后显式重放补齐。"""
    import hub.tm_proxy as proxy

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        real_write = proxy.write_snapshot
        calls = {"n": 0}

        def broken_write(*args, **kwargs):
            calls["n"] += 1
            raise sqlite3.OperationalError("disk I/O error (模拟磁盘满)")

        monkeypatch.setattr(proxy, "write_snapshot", broken_write)
        resp = cloud.post(
            "/api/ingest", json=widget_style_payload("dev-ob"), headers=HEADERS
        )
        assert resp.status_code == 200  # 官方协议不受影响
        assert calls["n"] == 1

        db = cloud.app.state.db
        assert db.fetchone(
            "SELECT state FROM tm_ingest_outbox WHERE device_id='dev-ob'"
        )["state"] == "pending"

        snap = cloud.get("/api/v1/health/ready").json()["components"]["snapshot"]
        assert snap["pending_outbox"] == 1
        assert snap["snapshot_degraded"] is True
        assert snap["last_snapshot_error"]
        assert cloud.get("/api/v1/health").json()["snapshot"]["pending_outbox"] == 1

        monkeypatch.setattr(proxy, "write_snapshot", real_write)
        from hub.tm_outbox import replay_pending

        stats = replay_pending(db, cloud.app.state.tm_core)
        assert stats["completed"] == 1
        assert db.fetchone(
            "SELECT COUNT(*) n FROM tm_snapshot_buckets WHERE device_id='dev-ob'"
        )["n"] == 1
        assert replay_pending(db, cloud.app.state.tm_core)["checked"] == 0  # 幂等


@requires_node
def test_outbox_replay_after_crash_before_snapshot(node_hub, tmp_path):
    """tm-core 成功、进程在快照前崩溃：重启后重放补齐，不产生重复桶。"""
    from hub.tm_outbox import new_request_id, record_pending, replay_pending

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    core = cloud.app.state.tm_core
    payload = widget_style_payload("dev-crash")
    with cloud:
        record_pending(
            db, request_id=new_request_id(), device_id="dev-crash", payload=payload
        )
        core.request("POST", "/api/ingest", json_body=payload)
        result = replay_pending(db, core)
        assert result["completed"] == 1
        assert db.fetchone(
            "SELECT COUNT(*) n FROM tm_snapshot_buckets WHERE device_id='dev-crash'"
        )["n"] == 1
        record_pending(
            db, request_id=new_request_id(), device_id="dev-crash", payload=payload
        )
        replay_pending(db, core)
        assert db.fetchone(
            "SELECT COUNT(*) n FROM tm_snapshot_buckets WHERE device_id='dev-crash'"
        )["n"] == 1


@requires_node
def test_concurrent_same_device_uploads_no_cross_talk(node_hub, tmp_path):
    """同设备并发上传：各请求快照取自各自响应，最终桶为时间最新值。"""
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        errors: list[str] = []
        barrier = threading.Barrier(8)

        def worker(i: int):
            try:
                barrier.wait(timeout=10)
                payload = widget_style_payload("dev-conc")
                payload["today"]["totalTokens"] = 1000 + i
                resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
                assert resp.status_code == 200
                body = resp.json()
                assert any(
                    d["deviceId"] == "dev-conc" for d in body["stats"]["devices"]
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert errors == []
        db = cloud.app.state.db
        assert db.fetchone(
            "SELECT COUNT(*) n FROM tm_snapshot_buckets WHERE device_id='dev-conc'"
        )["n"] == 1


@requires_node
def test_outbox_backpressure_cap(node_hub, tmp_path, monkeypatch):
    """pending 达上限 → 新 ingest 503 背压。"""
    import hub.tm_proxy as proxy

    cloud = make_cloud_app(tmp_path, node_hub.url, outbox_max=2, background=False)
    with cloud:
        def broken_write(*args, **kwargs):
            raise sqlite3.OperationalError("disk full")

        monkeypatch.setattr(proxy, "write_snapshot", broken_write)
        assert cloud.post("/api/ingest", json=widget_style_payload("bp-1"), headers=HEADERS).status_code == 200
        assert cloud.post("/api/ingest", json=widget_style_payload("bp-2"), headers=HEADERS).status_code == 200
        third = cloud.post("/api/ingest", json=widget_style_payload("bp-3"), headers=HEADERS)
        assert third.status_code == 503
        assert third.json()["error"] == "snapshot_backpressure"


@requires_node
def test_ingest_upstream_down_returns_503_pending_kept(tmp_path):
    """tm-core 不可达：503 + outbox 留待重试，不伪装成功。"""
    from conftest import NodeHub

    dead = NodeHub(tmp_path / "dead.json")
    port = dead.port
    dead.stop()
    cloud = make_cloud_app(tmp_path, f"http://127.0.0.1:{port}", background=False)
    with cloud:
        resp = cloud.post("/api/ingest", json=widget_style_payload("dev-503"), headers=HEADERS)
        assert resp.status_code == 503
        assert resp.json()["error"] == "upstream_unavailable"
        assert cloud.get("/api/stats", headers=HEADERS).status_code == 503
        db = cloud.app.state.db
        assert db.fetchone(
            "SELECT COUNT(*) n FROM tm_ingest_outbox WHERE state='pending'"
        )["n"] == 1


# ================================================================ P0-2 健康检查


def test_health_disabled_returns_404_not_attributeerror(tmp_path):
    """TOKEN_MONITOR_SECRET 为空：/api/health 404 结构化 disabled，无 500。"""
    from hub.config import Settings
    from hub.main import create_app
    from fastapi.testclient import TestClient

    settings = Settings(
        api_key=API_KEY, access_token=READ_KEY,
        database_path=tmp_path / "h.db", frontend_dir=tmp_path,
        max_records_per_push=500, tm_ingest_secret="",
    )
    client = TestClient(create_app(settings))
    resp = client.get("/api/health")
    assert resp.status_code == 404
    assert resp.json()["error"] == "disabled"
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/health/live").json()["ok"] is True


@requires_node
def test_ready_checks_components(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        resp = cloud.get("/api/v1/health/ready")
        assert resp.status_code == 200
        components = resp.json()["components"]
        assert components["sqlite_read"]["ok"] is True
        assert components["sqlite_write"]["ok"] is True
        assert components["tm_core"]["ok"] is True
        assert components["tm_core"]["hubBuild"] is not None


@requires_node
def test_ready_tm_core_down_503(tmp_path):
    from conftest import NodeHub

    dead = NodeHub(tmp_path / "dead.json")
    port = dead.port
    dead.stop()
    cloud = make_cloud_app(tmp_path, f"http://127.0.0.1:{port}", background=False)
    with cloud:
        resp = cloud.get("/api/v1/health/ready")
        assert resp.status_code == 503
        assert resp.json()["components"]["tm_core"]["ok"] is False


@requires_node
def test_ready_reports_sqlite_unwritable(node_hub, tmp_path, monkeypatch):
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        db = cloud.app.state.db
        real_execute = db.execute

        def failing_execute(sql, params=()):
            if "health_probe" in sql:
                raise sqlite3.OperationalError("attempt to write a readonly database")
            return real_execute(sql, params)

        monkeypatch.setattr(db, "execute", failing_execute)
        resp = cloud.get("/api/v1/health/ready")
        assert resp.status_code == 503
        assert resp.json()["components"]["sqlite_write"]["ok"] is False


@requires_node
def test_tm_core_midway_exit_all_503(tmp_path):
    from conftest import NodeHub

    hub = NodeHub(tmp_path / "mid.json")
    cloud = make_cloud_app(tmp_path, hub.url, background=False)
    try:
        with cloud:
            ingest(cloud, widget_style_payload("dev-mid"))
            hub.stop()
            assert cloud.get("/api/stats", headers=HEADERS).status_code == 503
            assert cloud.get("/api/health").status_code == 503
            sse = cloud.get("/api/stats/stream", headers=HEADERS)
            assert sse.status_code == 503
            assert "text/event-stream" not in sse.headers.get("content-type", "")
            assert cloud.get("/api/v1/tm/overview", headers=READ).status_code == 502
    finally:
        hub.stop()


@requires_node
def test_delayed_tm_core_bootstrap_retries_and_replay_once(node_hub, tmp_path):
    """tm-core 延迟启动：bootstrap 重试；旧数据回填只执行一次。"""
    from hub.tm_proxy import TmBackground, TmCore

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    core = cloud.app.state.tm_core
    background = TmBackground(cloud.app.state.settings, db, core)
    assert background._bootstrap() is True

    dead = TmCore("http://127.0.0.1:1", "x")
    assert TmBackground(cloud.app.state.settings, db, dead)._bootstrap() is False

    db._conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS tm_devices (device_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL DEFAULT '');
        """
    )
    db.execute(
        "INSERT INTO tm_devices (device_id, payload, last_seen_at)"
        " VALUES ('legacy-x', ?, '2026-01-01T00:00:00Z')"
        " ON CONFLICT(device_id) DO NOTHING",
        (json.dumps({"deviceId": "legacy-x", "today": {"totalTokens": 1}}),),
    )
    db.execute("DELETE FROM tm_meta WHERE key='legacy_reingested'")
    from hub.tm_snapshots import legacy_device_payloads

    first = legacy_device_payloads(db)
    assert len(first) == 1
    # 读取不得消耗待回灌队列；只有全部 payload 成功提交后才写幂等标记。
    second = legacy_device_payloads(db)
    assert len(second) == 1
    assert background._bootstrap() is True
    assert legacy_device_payloads(db) == []


# ================================================================ P0-3 活动口径


@requires_node
def test_activity_dashboard_timezone_shifts_hours(node_hub, tmp_path):
    """设备 UTC 桶 → 仪表盘 Asia/Tokyo：01:00Z 的用量落在 hour=10。"""
    from hub.tm_overview import activity_report
    from zoneinfo import ZoneInfo

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    with cloud:
        now = dt.datetime(2026, 8, 23, 12, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        seed_bucket(db, "utc-dev", "2026-08-23", "2026-08-23T01:00:00.000Z", 500)
        data = activity_report(db, "Asia/Tokyo", now=now)
        hourly = {h["hour"]: h["total"] for h in data["hourly"]}
        assert hourly.get(10) == 500  # UTC 01:00 = 东京 10:00
        assert data["time_zone"] == "Asia/Tokyo"
        assert data["hourly_day"] == "2026-08-23"


@requires_node
def test_activity_two_timezones_same_timeline(node_hub, tmp_path):
    """东京与洛杉矶设备同处仪表盘今日时间轴；跨日的桶不得并入今日 hourly。"""
    from hub.tm_overview import activity_report
    from zoneinfo import ZoneInfo

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    with cloud:
        now = dt.datetime(2026, 8, 23, 16, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        # 05:00Z = 14:00 JST 08-23；15:00Z = 00:00 JST 08-24（次日，不进今日 hourly）
        seed_bucket(db, "tky", "2026-08-23", "2026-08-23T05:00:00.000Z", 200)
        seed_bucket(db, "lax", "2026-08-22", "2026-08-22T15:00:00.000Z", 100)
        data = activity_report(db, "Asia/Tokyo", now=now)
        hourly = {h["hour"]: h["total"] for h in data["hourly"]}
        assert data["hourly_day"] == "2026-08-23"
        assert hourly.get(14, 0) >= 200
        # 08-22 15:00Z → 08-23 00:00 JST，属于今日
        assert hourly.get(0, 0) >= 100
        assert sum(hourly.values()) == 300


@requires_node
def test_activity_coverage_marks_low_coverage(node_hub, tmp_path):
    """首次中午接入（首桶全量）与 30 分钟间隔 → 低覆盖标记。"""
    from hub.tm_overview import activity_report

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    with cloud:
        now = dt.datetime(2026, 8, 23, 14, 0, tzinfo=dt.timezone.utc)
        day = "2026-08-23"
        seed_bucket(db, "first", day, f"{day}T12:00:00.000Z", 1000)
        cov = activity_report(db, "UTC", now=now)["coverage"]
        assert cov["attribution_mode"] == "delta-low-coverage"
        assert cov["first_sample_at"] == f"{day}T12:00:00.000Z"
        assert cov["observed_buckets"] == 1
        assert cov["expected_buckets"] == 1
        assert cov["coverage_percent"] == 100.0

        seed_bucket(db, "first", day, f"{day}T12:30:00.000Z", 1500)
        cov = activity_report(db, "UTC", now=now)["coverage"]
        assert cov["attribution_mode"] == "delta-low-coverage"
        assert cov["expected_buckets"] == 7  # 12:00..12:30
        assert cov["observed_buckets"] == 2
        assert cov["coverage_percent"] == round(2 / 7 * 100, 1)


@requires_node
def test_activity_dst_spring_forward_preserves_totals(node_hub, tmp_path):
    """夏令时跳变日：23 小时日总量守恒（桶按 UTC，换算到仪表盘时区）。"""
    from hub.tm_overview import activity_report
    from zoneinfo import ZoneInfo

    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    db = cloud.app.state.db
    with cloud:
        day = "2026-03-08"
        for i, hour_utc in enumerate((5, 6, 7, 8)):
            seed_bucket(db, "dst", day, f"{day}T0{hour_utc}:00:00.000Z", 100 * (i + 1))
        now = dt.datetime(2026, 3, 8, 20, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        data = activity_report(db, "Asia/Tokyo", now=now)
        assert sum(h["total"] for h in data["hourly"]) == 400


@requires_node
def test_period_windows_by_device_and_dashboard_period(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        pa = widget_style_payload("dev-win-a")
        pb = widget_style_payload("dev-win-b", tz="America/Los_Angeles")
        ingest(cloud, pa)
        ingest(cloud, pb)
        data = overview(cloud)
        by_device = data["period_windows_by_device"]
        assert by_device["dev-win-a"]["timeZone"] == "Asia/Tokyo"
        assert by_device["dev-win-b"]["timeZone"] == "America/Los_Angeles"
        dp = data["dashboard_period"]
        assert dp["time_zone"] == "Asia/Tokyo"
        assert len(dp["today"]["key"]) == 10 and len(dp["month"]["key"]) == 7
        assert "period_windows" in data


# ================================================================ P1-1 会话主键


@requires_node
def test_sessions_cross_device_same_client_sessionid_both_kept(node_hub, tmp_path):
    """两台设备相同 client:sessionId 但内容不同：都保留，主键含 deviceId。"""
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        def with_session(device_id, tokens):
            payload = widget_style_payload(device_id)
            payload["today"]["sessions"] = {
                "claude:s-777": {
                    "client": "claude", "sessionId": "s-777",
                    "totalTokens": tokens, "costUsd": 0.5,
                    "startedAt": _now_iso(), "lastUsedAt": _now_iso(),
                }
            }
            ingest(cloud, payload)

        with_session("dev-s1", 111)
        with_session("dev-s2", 222)
        data = overview(cloud)
        keys = {s["key"] for s in data["sessions"]}
        assert keys == {"dev-s1:claude:s-777", "dev-s2:claude:s-777"}
        meta = data["sessions_meta"]
        assert meta["sessions_total"] == 2
        assert meta["sessions_returned"] == 2
        assert meta["session_details_incomplete"] is False


# ================================================================ P1-4 partial


@requires_node
def test_overview_partial_on_history_failure(node_hub, tmp_path, monkeypatch):
    cloud = make_cloud_app(tmp_path, node_hub.url, background=False)
    with cloud:
        ingest(cloud, widget_style_payload("dev-p"))
        core = cloud.app.state.tm_core
        real_request = core.request

        class FakeResp:
            status_code = 503
            text = "upstream broken"

            def json(self):
                raise ValueError("no json")

        def flaky_history(method, path, **kwargs):
            if path == "/api/history":
                return FakeResp()
            return real_request(method, path, **kwargs)

        monkeypatch.setattr(core, "request", flaky_history)
        data = overview(cloud)
        assert data["partial"] is True
        codes = [e["code"] for e in data["partial_errors"]]
        assert "history_unavailable" in codes
        assert data["totals"]["today"]["totalTokens"] > 0


# ================================================================ P1-5 验证器


@requires_node
@pytest.mark.parametrize("mutation,fragment", [
    ({"today": {"input": 100}}, "旧别名"),
    ({"today": {"cost": 1}}, "旧别名"),
    ({"today": {"cost_usd": 1}}, "旧别名"),
    ({"today": {"cacheRead": 5}}, "旧别名"),
    ({"today": {"clients": {"claude": True}}}, "布尔"),
    ({"today": {"models": {"m": -3}}}, "负数"),
    ({"today": {"clients": {"claude": "123"}}}, "数字"),
    ({"today": {"sessions": {"c:s": {"startedAt": "not-a-date"}}}}, "时间戳"),
    ({"history": {"daily": [{"date": "2026-13-99"}]}}, "日期"),
    ({"periodWindows": {"timeZone": "UTC", "today": {"key": "2026/08/23"}}}, "格式非法"),
])
def test_validator_additions_reject(cloud, mutation, fragment):
    payload = {"deviceId": "dev-v", "today": {"totalTokens": 1}}
    payload.update(mutation)
    resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert resp.status_code == 400, mutation
    assert fragment in resp.json()["message"]


def test_validator_accepts_all_official_payload_shapes():
    """官方生产者载荷（widget/headless/limitsOnly/官方代码生成）全部通过。"""
    from hub.tm_validate import validate_ingest_payload

    for payload in (
        widget_style_payload(),
        agent_style_payload(),
        limits_only_payload(),
        official_payload({"deviceId": "g", "today": {"totalTokens": 5, "clients": {"c": 5}}}),
    ):
        validate_ingest_payload(payload)


# ================================================================ P1-6 统一正文限流


def _asgi_call(app, path: str, chunks: list[bytes], method: str = "POST", headers: list | None = None):
    import asyncio

    messages = [
        {"type": "http.request", "body": chunk, "more_body": i < len(chunks) - 1}
        for i, chunk in enumerate(chunks)
    ]
    received = {"n": 0}
    sent: list[dict] = []

    async def receive():
        if received["n"] < len(messages):
            msg = messages[received["n"]]
            received["n"] += 1
            return msg
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    base_headers = [(b"content-type", b"application/json")]
    if headers:
        base_headers += headers
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path,
        "raw_path": path.encode(), "query_string": b"",
        "headers": base_headers,
        "client": ("127.0.0.1", 0), "server": ("127.0.0.1", 80),
    }

    async def run():
        await app(scope, receive, send)

    asyncio.run(run())
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


@pytest.fixture()
def sync_app(tmp_path):
    from hub.config import Settings
    from hub.main import create_app
    from fastapi.testclient import TestClient

    settings = Settings(
        api_key=API_KEY, access_token=READ_KEY,
        database_path=tmp_path / "h.db", frontend_dir=tmp_path,
        max_records_per_push=500,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        yield app


def test_sync_push_body_limit_chunked_no_content_length(sync_app):
    pad = "a" * (1024 * 1024)
    part = json.dumps({"device": {"id": "d"}, "pad": pad}).encode()
    status, body = _asgi_call(sync_app, "/api/v1/sync/push", [part, part, part[:100]])
    assert status == 413
    assert b"payload_too_large" in body


def test_sync_push_body_limit_forged_small_header(sync_app):
    payload = b'{"device":{"id":"d"},"pad":"' + b"a" * (2 * 1024 * 1024 + 10) + b'"}'
    status, _ = _asgi_call(
        sync_app, "/api/v1/sync/push", [payload],
        headers=[(b"content-length", b"10")],
    )
    assert status == 413


def test_sync_push_body_limit_boundary_ok(sync_app):
    prefix = b'{"device":{"id":"d"},"records":[],"pad":"'
    quota = 2 * 1024 * 1024 - len(prefix) - 2
    payload = prefix + b"a" * quota + b'"}'
    assert len(payload) <= 2 * 1024 * 1024
    status, body = _asgi_call(
        sync_app, "/api/v1/sync/push", [payload[:1000], payload[1000:]],
        headers=[(b"authorization", f"Bearer {API_KEY}".encode())],
    )
    assert status == 200, body[:200]


def test_body_limit_all_write_paths_configured(sync_app):
    from hub.body_limit import TmBodyLimitMiddleware

    found = None
    for m in sync_app.user_middleware:
        if m.cls is TmBodyLimitMiddleware:
            found = m.kwargs.get("limits") or m.options.get("limits")
    assert found is not None
    assert set(found) == {"/api/ingest", "/api/subscriptions", "/api/v1/sync/push"}


# ================================================================ P1-2 查询计划/乱序/规模


def test_trend_query_uses_index_not_full_scan(tmp_path):
    from hub.db import Database
    from hub.tm_snapshots import ensure_schema

    db = Database(tmp_path / "plan.db")
    ensure_schema(db)
    day = dt.datetime.now(dt.timezone.utc).date().isoformat()
    seed_bucket(db, "d", day, f"{day}T00:00:00.000Z", 1)
    plan_rows = db.fetchall(
        "EXPLAIN QUERY PLAN SELECT local_day, today_total FROM ("
        " SELECT local_day, today_total, ROW_NUMBER() OVER ("
        "  PARTITION BY device_id, local_day ORDER BY bucket_start DESC"
        " ) AS rn FROM tm_snapshot_buckets WHERE local_day >= ?"
        ") WHERE rn = 1",
        ((dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat(),),
    )
    detail = " ".join(r["detail"] for r in plan_rows)
    assert "SCAN tm_snapshot_buckets" not in detail or "USING INDEX" in detail, detail
    db.close()


def test_out_of_order_late_write_keeps_true_latest(tmp_path):
    from hub.db import Database
    from hub.tm_snapshots import ensure_schema, trend_by_day

    db = Database(tmp_path / "ooo.db")
    ensure_schema(db)
    day = dt.datetime.now(dt.timezone.utc).date().isoformat()
    seed_bucket(db, "d", day, f"{day}T23:55:00.000Z", 900, f"{day}T23:55:30.000Z")
    seed_bucket(db, "d", day, f"{day}T23:50:00.000Z", 800, f"{day}T23:56:00.000Z")
    trend = {r["day"]: r["total"] for r in trend_by_day(db)}
    assert trend[day] == 900
    db.close()


def test_scale_generator_100_devices_370_days(tmp_path):
    """等价规模生成器：100 设备 × 370 天（每日锚点 + 当日 5 分钟级）。"""
    from hub.db import Database
    from hub.tm_overview import trend_models_by_day
    from hub.tm_snapshots import ensure_schema, trend_by_day

    db = Database(tmp_path / "scale.db")
    ensure_schema(db)
    today = dt.datetime.now(dt.timezone.utc).date()
    rows = []
    for d in range(100):
        device = f"scale-dev-{d:03d}"
        for day_offset in range(370):
            day = (today - dt.timedelta(days=day_offset)).isoformat()
            base = 1000 + d * 10
            rows.append((device, day, f"{day}T23:55:00.000Z", base, f"{day}T23:55:30.000Z", "{}"))
        for slot in range(288):
            moment = dt.datetime.combine(today, dt.time(0, 0), tzinfo=dt.timezone.utc) + dt.timedelta(minutes=5 * slot)
            stamp = moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            rows.append((device, today.isoformat(), stamp, slot * 7, stamp, "{}"))
    with db.transaction():
        db.executemany(
            "INSERT OR REPLACE INTO tm_snapshot_buckets"
            " (device_id, local_day, bucket_start, today_total, server_received_at, models_json)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    total_rows = db.fetchone("SELECT COUNT(*) n FROM tm_snapshot_buckets")["n"]
    assert total_rows >= 100 * (370 + 288) - 200  # 允许生成器内桶重叠

    started = time.monotonic()
    trend = trend_by_day(db)
    elapsed_trend = time.monotonic() - started
    assert len(trend) == 30
    started = time.monotonic()
    models = trend_models_by_day(db)
    elapsed_models = time.monotonic() - started
    assert len(models) == 30
    assert elapsed_trend < 10 and elapsed_models < 10, (elapsed_trend, elapsed_models)
    db.close()
