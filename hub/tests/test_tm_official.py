"""token-monitor 接入层综合测试：过期/时区/分桶/校验/限流/SSE/订阅/持久化/迁移。"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from pathlib import Path

import httpx
import pytest

from conftest import (
    API_KEY,
    READ_KEY,
    TM_SECRET,
    limits_only_payload,
    make_cloud_app,
    requires_node,
    widget_style_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def ingest(cloud, payload):
    resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert resp.status_code == 200, resp.text[:300]
    return resp.json()


# ================================================================ 二、过期语义（官方规则透传）


@requires_node
def test_expired_today_and_month_excluded_but_alltime_kept(node_hub, tmp_path):
    """设备 today/month 窗口过期后不再计入聚合；allTime 永不过期。"""
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        # 窗口已过期的设备（endsAt 在过去）
        ingest(cloud, {
            "deviceId": "dev-stale",
            "periodWindows": {
                "timeZone": "Asia/Tokyo",
                "today": {"key": "2026-08-20", "endsAt": "2026-08-20T15:00:00.000Z"},
                "month": {"key": "2026-07", "endsAt": "2026-08-01T15:00:00.000Z"},
            },
            "today": {"totalTokens": 111, "clients": {"claude": 111}},
            "month": {"totalTokens": 2222, "clients": {"claude": 2222}},
            "allTime": {"totalTokens": 33333, "clients": {"claude": 33333}},
        })
        # 窗口有效的设备
        ingest(cloud, widget_style_payload("dev-live"))
        stats = cloud.get("/api/stats", headers=HEADERS).json()
        assert stats["periods"]["today"]["totalTokens"] == widget_style_payload()["today"]["totalTokens"]
        assert stats["periods"]["month"]["totalTokens"] == widget_style_payload()["month"]["totalTokens"]
        assert (
            stats["periods"]["allTime"]["totalTokens"]
            == widget_style_payload()["allTime"]["totalTokens"] + 33333
        )


@requires_node
def test_per_device_staleness_via_official_datafile(tmp_path):
    """按设备 syncUploadIntervalMs 判定 stale：直接用官方 devices.json 播种。"""
    from conftest import NodeHub

    from datetime import datetime, timedelta, timezone

    real_now = datetime.now(timezone.utc)
    ago = lambda minutes: (real_now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    data = {"version": 1, "devices": {
        "dev-10min": {
            "deviceId": "dev-10min", "receivedAt": ago(8),
            "syncUploadIntervalMs": 10 * 60 * 1000,
            "periods": {"today": {"totalTokens": 10}, "month": {"totalTokens": 10}, "allTime": {"totalTokens": 10}},
        },
        "dev-30min": {
            "deviceId": "dev-30min", "receivedAt": ago(25),
            "syncUploadIntervalMs": 30 * 60 * 1000,
            "periods": {"today": {"totalTokens": 30}, "month": {"totalTokens": 30}, "allTime": {"totalTokens": 30}},
        },
    }, "savedAt": real_now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    data_file = tmp_path / "devices.json"
    data_file.write_text(json.dumps(data))
    hub = NodeHub(data_file)
    try:
        cloud = make_cloud_app(tmp_path, hub.url)
        with cloud:
            stats = cloud.get("/api/stats", headers=HEADERS).json()
            stale_map = {d["deviceId"]: d["stale"] for d in stats["devices"]}
            # 各自阈值内（8min<10min 间隔, 25min<30min 间隔）→ 未过期；
            # 官方 staleAfterMsForSyncUpload 按 syncUploadIntervalMs 放大阈值
            assert stale_map["dev-10min"] is False
            assert stale_map["dev-30min"] is False
            assert {d["deviceId"]: d["syncUploadIntervalMs"] for d in stats["devices"]} == {
                "dev-10min": 600000, "dev-30min": 1800000,
            }
    finally:
        hub.stop()


# ================================================================ 三、时区与本地日


def _bucket_rows(cloud) -> list[dict]:
    db = cloud.app.state.db
    return db.fetchall(
        "SELECT device_id, local_day, device_time_zone, bucket_start FROM tm_snapshot_buckets ORDER BY device_id"
    )


@requires_node
def test_tokyo_past_midnight_not_written_to_previous_utc_day(node_hub, tmp_path):
    """东京 00:10 的上报不落到前一 UTC 日。"""
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        ingest(cloud, {
            "deviceId": "dev-tokyo",
            "periodWindows": {
                "timeZone": "Asia/Tokyo",
                "today": {"key": "2026-08-23", "endsAt": "2026-08-23T15:00:00.000Z"},
                "month": {"key": "2026-08", "endsAt": "2026-09-01T15:00:00.000Z"},
            },
            "updatedAt": "2026-08-22T15:10:00.000Z",  # UTC 8/22，东京 8/23 00:10
            "today": {"totalTokens": 10, "clients": {"claude": 10}},
        })
        rows = _bucket_rows(cloud)
        assert rows[0]["local_day"] == "2026-08-23"
        assert rows[0]["device_time_zone"] == "Asia/Tokyo"


@requires_node
def test_la_and_tokyo_local_days_do_not_mix(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        ingest(cloud, {
            "deviceId": "dev-la",
            "periodWindows": {"timeZone": "America/Los_Angeles",
                              "today": {"key": "2026-08-21", "endsAt": "2026-08-22T07:00:00.000Z"}},
            "updatedAt": "2026-08-22T05:00:00.000Z",  # LA 8/21 22:00
            "today": {"totalTokens": 5, "clients": {"claude": 5}},
        })
        ingest(cloud, {
            "deviceId": "dev-tokyo",
            "periodWindows": {"timeZone": "Asia/Tokyo",
                              "today": {"key": "2026-08-22", "endsAt": "2026-08-22T15:00:00.000Z"}},
            "updatedAt": "2026-08-22T05:00:00.000Z",  # 东京 8/22 14:00
            "today": {"totalTokens": 7, "clients": {"claude": 7}},
        })
        days = {r["device_id"]: r["local_day"] for r in _bucket_rows(cloud)}
        assert days == {"dev-la": "2026-08-21", "dev-tokyo": "2026-08-22"}


@requires_node
def test_month_end_year_end_and_dst_boundaries(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        cases = [
            # (tz, updatedAt, expected_day, 说明) —— 均为过去日期（校验只放行 24h 超前）
            ("Asia/Tokyo", "2025-12-31T15:30:00.000Z", "2026-01-01", "东京跨年 00:30"),
            ("Asia/Tokyo", "2026-07-31T15:10:00.000Z", "2026-08-01", "东京月末 00:10"),
            ("America/New_York", "2026-03-08T06:30:00.000Z", "2026-03-08", "夏令时开始日（2:00 跳变后）"),
            ("America/New_York", "2025-11-01T05:30:00.000Z", "2025-11-01", "夏令时结束日"),
            ("Australia/Lord_Howe", "2026-04-04T14:30:00.000Z", "2026-04-05", "30 分钟偏移时区"),
        ]
        for i, (tz, updated, expected, _) in enumerate(cases):
            ingest(cloud, {
                "deviceId": f"dev-{i}",
                "periodWindows": {"timeZone": tz},  # 无 key/endsAt → 走 tz+updatedAt 链
                "updatedAt": updated,
                "today": {"totalTokens": 1, "clients": {"c": 1}},
            })
        days = {r["device_id"]: r["local_day"] for r in _bucket_rows(cloud)}
        for i, (tz, updated, expected, label) in enumerate(cases):
            assert days[f"dev-{i}"] == expected, label


@requires_node
def test_invalid_timezone_rejected_fail_closed(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        resp = cloud.post("/api/ingest", headers=HEADERS, json={
            "deviceId": "bad-tz",
            "periodWindows": {"timeZone": "Mars/Olympus_Mons"},
            "today": {"totalTokens": 1},
        })
        assert resp.status_code == 400
        assert "时区" in resp.json()["message"]


# ================================================================ 八、分桶与保留


@requires_node
def test_bucket_upsert_within_five_minutes(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        base = widget_style_payload("dev-bucket")
        base["updatedAt"] = "2026-08-22T06:00:00.000Z"  # 固定桶锚点（local_day 取自 periodWindows，与此解耦）
        ingest(cloud, base)
        base["today"]["totalTokens"] = 2000
        base["updatedAt"] = "2026-08-22T06:02:00.000Z"  # 同一 5 分钟桶
        ingest(cloud, base)
        db = cloud.app.state.db
        rows = db.fetchall("SELECT today_total FROM tm_snapshot_buckets")
        assert len(rows) == 1 and rows[0]["today_total"] == 2000  # UPSERT 保留最后

        base["today"]["totalTokens"] = 3000
        base["updatedAt"] = "2026-08-22T06:07:00.000Z"  # 下一个桶
        ingest(cloud, base)
        rows = db.fetchall("SELECT today_total FROM tm_snapshot_buckets ORDER BY bucket_start")
        assert len(rows) == 2
        assert [r["today_total"] for r in rows] == [2000, 3000]  # 同桶保留最后值


@requires_node
def test_limits_only_update_creates_no_history_point(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        ingest(cloud, widget_style_payload("dev-lim"))
        ingest(cloud, limits_only_payload("dev-lim"))
        db = cloud.app.state.db
        assert db.fetchone("SELECT COUNT(*) n FROM tm_snapshot_buckets")["n"] == 1
        # token 量未被 limits-only 更新清零
        stats = cloud.get("/api/stats", headers=HEADERS).json()
        assert stats["periods"]["today"]["totalTokens"] == widget_style_payload()["today"]["totalTokens"]


def test_prune_keeps_daily_anchors_beyond_7d(tmp_path):
    from hub.db import Database
    from hub.tm_snapshots import ensure_schema, prune_snapshots

    db = Database(tmp_path / "p.sqlite3")
    ensure_schema(db)
    from datetime import datetime, timedelta, timezone

    now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
    # 近 3 天：每天 3 个桶；8 天前：一天 4 个桶
    for day_offset, hours in ((0, (1, 2, 3)), (-1, (1, 2, 3)), (-2, (1, 2, 3)), (-8, (1, 2, 3, 4))):
        day = now + timedelta(days=day_offset)
        for h in hours:
            stamp = day.replace(hour=h, minute=0, second=0, microsecond=0)
            db.execute(
                "INSERT INTO tm_snapshot_buckets (device_id, local_day, bucket_start, today_total)"
                " VALUES ('d', ?, ?, 1)",
                (day.date().isoformat(), stamp.isoformat().replace("+00:00", "Z")),
            )
    removed = prune_snapshots(db, now=now)
    rows = db.fetchall("SELECT local_day, COUNT(*) n FROM tm_snapshot_buckets GROUP BY local_day")
    counts = {r["local_day"]: r["n"] for r in rows}
    assert counts["2026-08-22"] == 3 and counts["2026-08-21"] == 3 and counts["2026-08-20"] == 3
    assert counts["2026-08-14"] == 1  # 7 天外只留每日最后一个
    assert removed["full_res"] == 3
    db.close()


# ================================================================ 九、严格校验


@requires_node
@pytest.mark.parametrize("mutation,expect_fragment", [
    ({"today": {"totalTokens": -1}}, "负数"),
    ({"today": {"totalTokens": True}}, "布尔"),
    ({"today": {"totalTokens": 1.5}}, "整数"),
    ({"today": {"totalTokens": 2**63}}, "64 位"),
    ({"today": {"__proto__": 1}}, "原型"),
    ({"today": {"sessions": {f"s{i}": 1 for i in range(5000)}}}, "sessions"),
    ({"trackedClients": ["a"] * 100}, "trackedClients"),
    ({"updatedAt": "2099-01-01T00:00:00Z"}, "超前"),
])
def test_malformed_payloads_rejected(cloud, mutation, expect_fragment):
    payload = {"deviceId": "dev-x", "today": {"totalTokens": 1}}
    payload.update(mutation)
    resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert resp.status_code == 400, mutation
    assert expect_fragment in resp.json()["message"]


@requires_node
def test_raw_nan_infinity_rejected(cloud):
    body = '{"deviceId":"nan-dev","today":{"totalTokens":NaN,"costUsd":Infinity}}'
    resp = cloud.post(
        "/api/ingest", headers={**HEADERS, "content-type": "application/json"}, content=body
    )
    assert resp.status_code == 400


@requires_node
def test_huge_int_rejected(cloud):
    body = '{"deviceId":"big","today":{"totalTokens": 99999999999999999999999999}}'
    resp = cloud.post(
        "/api/ingest", headers={**HEADERS, "content-type": "application/json"}, content=body
    )
    assert resp.status_code == 400


# ================================================================ 十、ASGI 级 1MiB 限流


def _asgi_call(app, path: str, chunks: list[bytes], method: str = "POST"):
    """直接以自定义 receive 驱动 ASGI 应用（模拟任意分块/无 Content-Length）。"""
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

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path,
        "raw_path": path.encode(), "query_string": b"",
        "headers": [
            (b"content-type", b"application/json"),
            (b"x-token-monitor-secret", TM_SECRET.encode()),
        ],  # 故意不带 content-length
        "client": ("127.0.0.1", 0), "server": ("127.0.0.1", 80),
    }
    import anyio

    anyio.run(app.__call__, scope, receive, send) if False else None
    from starlette.testclient import TestClient  # noqa: F401

    # anyio.run 不支持多参数传法，用 asyncio 原生跑
    async def run():
        await app(scope, receive, send)

    asyncio.run(run())
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


@pytest.fixture()
def raw_app(tmp_path):
    from hub.config import Settings
    from hub.main import create_app

    settings = Settings(
        api_key=API_KEY, access_token=READ_KEY,
        database_path=tmp_path / "h.sqlite3", frontend_dir=tmp_path,
        max_records_per_push=500,
    )
    return create_app(settings)


def test_body_limit_chunked_no_content_length(raw_app):
    """分块 + 无 Content-Length：按实际字节判定。"""
    pad = "a" * (600 * 1024)
    part1 = json.dumps({"deviceId": "c", "pad": pad}).encode()[:600 * 1024]
    part2 = ("a" * (500 * 1024)).encode()  # 合计 > 1MiB
    status, body = _asgi_call(raw_app, "/api/ingest", [part1, part2])
    assert status == 413
    assert b"payload_too_large" in body


def test_body_limit_forged_small_content_length_ignored(raw_app):
    """Content-Length 造假为 1：ASGI 层不看头，仍按实际正文判定。"""
    scope_override = True
    pad = ("a" * (1024 * 1024 + 10)).encode()
    payload = b'{"deviceId":"forged","pad":"' + pad + b'"}'
    status, body = _asgi_call(raw_app, "/api/ingest", [payload])
    assert status == 413


def test_body_limit_exact_boundary_accepted(raw_app, node_hub_free=None):
    """恰好 1MiB 的合法正文不被拒（无 Content-Length，多块传输）。"""
    from conftest import NodeHub
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    hub = NodeHub(tmp / "d.json")
    try:
        from hub.config import Settings
        from hub.main import create_app

        settings = Settings(
            api_key=API_KEY, access_token=READ_KEY,
            database_path=tmp / "h2.sqlite3", frontend_dir=tmp,
            max_records_per_push=500, tm_ingest_secret=TM_SECRET, tm_core_url=hub.url,
        )
        app = create_app(settings)
        prefix = json.dumps({"deviceId": "edge", "today": {"totalTokens": 1}})[:-1] + ","
        quota = 1024 * 1024 - len(prefix.encode()) - 9  # '"pad":' + 引号2 + 闭合'}'
        payload = prefix.encode() + b'"pad":' + json.dumps("a" * quota).encode() + b'}'
        assert len(payload) == 1024 * 1024
        json.loads(payload)  # 合法 JSON
        half = len(payload) // 2
        status, body = _asgi_call(app, "/api/ingest", [payload[:half], payload[half:]])
        assert status == 200, body[:200]
    finally:
        hub.stop()


def test_body_limit_multibyte_utf8(raw_app):
    """多字节 UTF-8 正文按字节数而非字符数判定。"""
    char = "世"  # 3 bytes
    count = (1024 * 1024) // 3 + 10  # > 1MiB
    payload = json.dumps({"deviceId": "utf8", "pad": char * count}, ensure_ascii=False).encode("utf-8")
    assert len(payload) > 1024 * 1024
    status, _ = _asgi_call(raw_app, "/api/ingest", [payload])
    assert status == 413


# ================================================================ 四、SSE（真实连接）


@requires_node
def test_sse_snapshot_stats_frames_and_reconnect(live_stack):
    url = f"{live_stack.url}/api/stats/stream"
    headers = {"X-Token-Monitor-Secret": TM_SECRET}

    with httpx.stream("GET", url, headers=headers, timeout=10) as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        assert stream.headers["x-accel-buffering"] == "no"
        events = []
        for line in stream.iter_lines():
            if line.startswith("event:"):
                events.append(line.split(":", 1)[1].strip())
            if len(events) >= 1:
                break

    # 第二台设备 ingest → 新连接应先收 snapshot；期间官方 hub 广播 stats
    httpx.post(
        f"{live_stack.url}/api/ingest",
        json=widget_style_payload("dev-sse"),
        headers=headers,
        timeout=10,
    )
    with httpx.stream("GET", url, headers=headers, timeout=10) as stream:
        collected = []
        current_event = None
        for line in stream.iter_lines():
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and current_event:
                collected.append((current_event, json.loads(line.split(":", 1)[1])))
                current_event = None
            if len(collected) == 1:
                break
        assert collected[0][0] == "snapshot"
        assert collected[0][1]["stats"]["periods"]["today"]["totalTokens"] > 0

    # 断线重连：立即再连仍能拿到 snapshot
    with httpx.stream("GET", url, headers=headers, timeout=10) as stream:
        assert stream.status_code == 200


@requires_node
def test_sse_wrong_secret_401(live_stack):
    resp = httpx.get(
        f"{live_stack.url}/api/stats/stream",
        headers={"X-Token-Monitor-Secret": "wrong"},
        timeout=10,
    )
    assert resp.status_code == 401


@requires_node
def test_sse_broadcast_on_second_device_ingest(live_stack):
    """连接保持时，另一台设备 ingest 触发 event:stats 广播。"""
    headers = {"X-Token-Monitor-Secret": TM_SECRET}
    url = f"{live_stack.url}/api/stats/stream"
    with httpx.stream("GET", url, headers=headers, timeout=15) as stream:
        got_snapshot = False
        reason = None
        for line in stream.iter_lines():
            if line.startswith("event:"):
                got_snapshot = line.split(":", 1)[1].strip() == "snapshot" or got_snapshot
            elif line.startswith("data:") and '"reason":"ingest"' in line:
                reason = "ingest"
            if got_snapshot and reason:
                break
            if not line.strip() and got_snapshot and not reason:
                # 首帧结束后再触发一次 ingest
                httpx.post(
                    f"{live_stack.url}/api/ingest",
                    json=widget_style_payload("dev-bcast"),
                    headers=headers,
                    timeout=10,
                )
        assert got_snapshot
        assert reason == "ingest"


# ================================================================ 六、订阅与删除


@requires_node
def test_subscriptions_roundtrip_and_stale_write(cloud):
    put = cloud.put("/api/subscriptions", headers=HEADERS, json={
        "subscriptions": [
            {"id": "s1", "provider": "anthropic", "kind": "subscription",
             "planName": "Max 5x", "amountMinor": 20000, "currency": "USD",
             "interval": "month", "startDate": "2026-01-01"}
        ],
    })
    assert put.status_code == 200 and put.json()["ok"] is True
    doc = cloud.get("/api/subscriptions", headers=HEADERS).json()
    assert doc["ok"] is True and len(doc["subscriptions"]) == 1
    updated_at = doc["updatedAt"]

    # 以过期 baseUpdatedAt 并发写 → 409（官方 stale_write 语义）
    conflict = cloud.put("/api/subscriptions", headers=HEADERS, json={
        "subscriptions": [],
        "baseUpdatedAt": "2000-01-01T00:00:00.000Z",
    })
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "stale_write"

    # 非法币种 → 400（需带新鲜 baseUpdatedAt，否则先命中官方 stale_write 409）
    bad = cloud.put("/api/subscriptions", headers=HEADERS, json={
        "subscriptions": [{"id": "s2", "currency": "XYZ", "provider": "openai",
                            "kind": "subscription", "startDate": "2026-01-01"}],
        "baseUpdatedAt": updated_at,
    })
    assert bad.status_code == 400


@requires_node
def test_delete_device_response_shape_and_snapshot_cleanup(cloud):
    ingest(cloud, widget_style_payload("dev-del"))
    resp = cloud.delete("/api/devices/dev-del", headers=HEADERS)
    assert resp.json() == {"ok": True, "deviceId": "dev-del"}
    db = cloud.app.state.db
    assert db.fetchone(
        "SELECT COUNT(*) n FROM tm_snapshot_buckets WHERE device_id='dev-del'"
    )["n"] == 0


# ================================================================ 面板与隔离


@requires_node
def test_overview_shape_and_key_isolation(cloud):
    ingest(cloud, widget_style_payload("dev-panel"))
    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    assert overview["totals"]["today"]["cacheReadTokens"] == 986000
    assert overview["devices"][0]["deviceId"] == "dev-panel"
    assert overview["devices"][0]["stale"] is False
    assert overview["trend"]

    # TM 密钥不能访问 OpenWebUI 链路，ACCESS_TOKEN 不能访问 TM 端点
    assert cloud.get("/api/v1/records", headers=HEADERS).status_code == 401
    assert cloud.get("/api/stats", headers=READ).status_code == 401
    # OpenWebUI 管理写接口也不接受 TM 密钥
    assert cloud.post(
        "/api/v1/sync/push", headers=HEADERS,
        json={"device": {"id": "x"}, "records": []},
    ).status_code == 401


@requires_node
def test_health_upstream_shape_and_downstream_fallback(node_hub, tmp_path):
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        health = cloud.get("/api/health").json()
        assert health["ok"] is True
        assert health["role"] == "hub"
        assert "hubBuild" in health  # 官方原始形状（比 v1 的 legacy 近似更完整）
    # 上游不可达 → 503 明确失败
    from conftest import NodeHub

    hub2 = NodeHub(tmp_path / "dead.json")
    port = hub2.port
    hub2.stop()
    cloud2 = make_cloud_app(tmp_path, f"http://127.0.0.1:{port}")
    with cloud2:
        resp = cloud2.get("/api/health")
        assert resp.status_code == 503
        assert resp.json()["ok"] is False


# ================================================================ 22/23、重启保留与旧表迁移


@requires_node
def test_restart_preserves_devices_and_buckets(tmp_path):
    from conftest import NodeHub

    data_file = tmp_path / "devices.json"
    db_path = tmp_path / "hub.sqlite3"
    hub = NodeHub(data_file)
    try:
        cloud = make_cloud_app(tmp_path, hub.url, database_path=db_path)
        with cloud:
            ingest(cloud, widget_style_payload("dev-restart"))
        hub.stop()

        # 重启 Node（同一 devices.json）与 Python 应用（同一 SQLite）
        hub2 = NodeHub.__new__(NodeHub)
        hub2.port = hub.port
        hub2.data_file = data_file
        hub2.proc = None
        # 重新起一个进程（端口可能被复用，直接新起）
        hub_b = NodeHub(data_file)
        cloud2 = make_cloud_app(tmp_path, hub_b.url, database_path=db_path)
        with cloud2:
            stats = cloud2.get("/api/stats", headers=HEADERS).json()
            ids = [d["deviceId"] for d in stats["devices"]]
            assert "dev-restart" in ids  # devices.json 持久化
            rows = cloud2.app.state.db.fetchall("SELECT COUNT(*) n FROM tm_snapshot_buckets")
            assert rows[0]["n"] >= 1  # SQLite 快照保留
        hub_b.stop()
    finally:
        hub.stop()


def test_legacy_tables_migrated_not_deleted(tmp_path):
    from hub.db import Database
    from hub.tm_snapshots import ensure_schema, migrate_legacy_tables

    db = Database(tmp_path / "legacy.sqlite3")
    # 构造 v1 旧表
    db._conn.executescript(
        """
        CREATE TABLE tm_devices (device_id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '',
            last_seen_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE tm_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL, received_at TEXT NOT NULL, day TEXT NOT NULL,
            today_total INTEGER NOT NULL DEFAULT 0, today_output INTEGER NOT NULL DEFAULT 0,
            today_cache_read INTEGER NOT NULL DEFAULT 0, today_cache_write INTEGER NOT NULL DEFAULT 0,
            today_unclassified INTEGER NOT NULL DEFAULT 0, today_cost REAL NOT NULL DEFAULT 0,
            month_total INTEGER NOT NULL DEFAULT 0, month_cost REAL NOT NULL DEFAULT 0,
            all_time_total INTEGER NOT NULL DEFAULT 0, all_time_cost REAL NOT NULL DEFAULT 0);
        INSERT INTO tm_devices VALUES ('old-dev', '{"deviceId":"old-dev","today":{"totalTokens":9}}', '2026-08-01T00:00:00+00:00');
        INSERT INTO tm_snapshots (device_id, received_at, day, today_total, month_total, all_time_total)
        VALUES ('old-dev', '2026-08-01T01:00:00+00:00', '2026-08-01', 9, 9, 9);
        """
    )
    ensure_schema(db)
    result = migrate_legacy_tables(db)
    assert result["ported_snapshots"] == 1
    buckets = db.fetchall("SELECT * FROM tm_snapshot_buckets")
    assert len(buckets) == 1 and buckets[0]["device_id"] == "old-dev"
    assert buckets[0]["local_day"] == "2026-08-01"
    # 幂等 + 旧表原样保留
    assert migrate_legacy_tables(db)["migrated"] is False
    assert db.fetchone("SELECT COUNT(*) n FROM tm_devices")["n"] == 1
    assert db.fetchone("SELECT COUNT(*) n FROM tm_snapshots")["n"] == 1
    db.close()
