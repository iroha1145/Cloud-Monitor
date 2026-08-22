from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from hub.config import Settings
from hub.main import create_app

API_KEY = "unit-test-admin-key"
READ_KEY = "unit-test-read-key"
TM_SECRET = "tm-shared-secret-0123456789"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def make_client(tmp_path, tm_secret: str = TM_SECRET) -> TestClient:
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=tmp_path / "no-frontend",
        max_records_per_push=500,
        tm_ingest_secret=tm_secret,
    )
    app = create_app(settings)
    return TestClient(app)


def device_summary(device_id="dev-a", **overrides) -> dict:
    payload = {
        "deviceId": device_id,
        "hostname": "MacBook-Pro",
        "platform": "darwin",
        "osName": "macOS",
        "osVersion": "15.5",
        "agentVersion": "1.8.2",
        "agentRuntime": "widget",
        "trackedClients": ["claude", "codex"],
        "projectsEnabled": False,
        "historyAvailable": True,
        "syncUploadIntervalMs": 300000,
        "periodWindows": {"timeZone": "Asia/Tokyo"},
        "today": {
            "totalTokens": 1000,
            "outputTokens": 300,
            "cacheReadTokens": 400,
            "cacheWriteTokens": 100,
            "unclassifiedTokens": 200,
            "costUsd": 1.25,
            "clients": {"claude": 700, "codex": 300},
            "clientModels": {"claude": {"opus": 500, "sonnet": 200}, "codex": {"gpt-5": 300}},
        },
        "month": {"totalTokens": 9000, "costUsd": 9.5, "clients": {"claude": 9000}, "clientModels": {}},
        "allTime": {"totalTokens": 50000, "costUsd": 60, "clients": {"claude": 50000}, "clientModels": {}},
    }
    payload.update(overrides)
    return payload


TM_AUTH = {
    "Authorization": f"Bearer {TM_SECRET}",
    "X-Token-Monitor-Secret": TM_SECRET,
}


def test_health_shape_is_legacy_compatible(tmp_path):
    client = make_client(tmp_path)
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["role"] == "hub"
    assert body["deviceCount"] == 0
    assert body["secretRequired"] is True
    assert "hubBuild" not in body  # legacy Hub 按官方文档保持兼容


def test_ingest_requires_secret(tmp_path):
    client = make_client(tmp_path)
    assert client.post("/api/ingest", json=device_summary()).status_code == 401
    wrong = {"X-Token-Monitor-Secret": "not-the-secret"}
    assert client.post("/api/ingest", json=device_summary(), headers=wrong).status_code == 401


def test_ingest_stores_and_overview_reads(tmp_path):
    client = make_client(tmp_path)
    resp = client.post("/api/ingest", json=device_summary(), headers=TM_AUTH)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    overview = client.get("/api/v1/tm/overview", headers=READ).json()
    today = overview["totals"]["today"]
    assert today["totalTokens"] == 1000
    assert today["cacheReadTokens"] == 400          # 缓存拆分保留
    assert today["outputTokens"] == 300
    assert today["clients"] == {"claude": 700, "codex": 300}
    assert today["models"] == {"opus": 500, "sonnet": 200, "gpt-5": 300}
    assert today["costUsd"] == pytest.approx(1.25)
    assert overview["totals"]["month"]["totalTokens"] == 9000
    assert overview["totals"]["allTime"]["totalTokens"] == 50000
    assert len(overview["devices"]) == 1
    dev = overview["devices"][0]
    assert dev["hostname"] == "MacBook-Pro" and dev["osName"] == "macOS"


def test_overview_requires_access_token(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/ingest", json=device_summary(), headers=TM_AUTH)
    assert client.get("/api/v1/tm/overview").status_code == 401
    # TM 密钥是设备推送密钥，不能当只读密钥用
    assert client.get("/api/v1/tm/overview", headers=TM_AUTH).status_code == 401
    # ACCESS_TOKEN 也不能推送
    assert client.post("/api/ingest", json=device_summary(), headers=READ).status_code == 401


def test_stats_aggregates_multiple_devices(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/ingest", json=device_summary("dev-a"), headers=TM_AUTH)
    client.post(
        "/api/ingest",
        json=device_summary(
            "dev-b",
            hostname="ThinkPad",
            platform="win32",
            today={"totalTokens": 500, "outputTokens": 100,
                   "clients": {"cursor": 500}, "clientModels": {"cursor": {"gpt-5": 500}}},
        ),
        headers=TM_AUTH,
    )
    stats = client.get("/api/stats", headers=TM_AUTH).json()
    today = stats["periods"]["today"]
    assert today["totalTokens"] == 1500
    assert today["clients"] == {"claude": 700, "codex": 300, "cursor": 500}
    assert today["models"]["opus"] == 500 and today["models"]["gpt-5"] == 800
    assert {d["deviceId"] for d in stats["devices"]} == {"dev-a", "dev-b"}
    assert stats["periods"]["allTime"]["totalTokens"] == 100000  # 两台设备默认各 50000


def test_reingest_updates_device_single_row(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/ingest", json=device_summary(), headers=TM_AUTH)
    client.post("/api/ingest", json=device_summary(today=device_summary()["today"] | {"totalTokens": 2000}), headers=TM_AUTH)

    overview = client.get("/api/v1/tm/overview", headers=READ).json()
    assert len(overview["devices"]) == 1
    assert overview["totals"]["today"]["totalTokens"] == 2000
    # 快照历史累积（趋势数据）
    db = client.app.state.db
    assert db.fetchone("SELECT COUNT(*) n FROM tm_snapshots")["n"] == 2


def test_delete_device(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/ingest", json=device_summary("dev-a"), headers=TM_AUTH)
    resp = client.delete("/api/devices/dev-a", headers=TM_AUTH)
    assert resp.status_code == 200
    assert client.get("/api/stats", headers=TM_AUTH).json()["devices"] == []


def test_ingest_disabled_without_secret(tmp_path):
    client = make_client(tmp_path, tm_secret="")
    assert client.post("/api/ingest", json=device_summary()).status_code == 404
    health = client.get("/api/health").json()
    assert health["secretRequired"] is False


def test_ingest_rejects_missing_device_id(tmp_path):
    client = make_client(tmp_path)
    bad = device_summary()
    bad["deviceId"] = ""
    assert client.post("/api/ingest", json=bad, headers=TM_AUTH).status_code == 400


def test_trend_daily_rollup(tmp_path):
    client = make_client(tmp_path)
    db = client.app.state.db
    # 手工造 3 天快照：每天最后一个快照的 today_total 代表当日量
    from hub.tm_hub import apply_ingest

    for day, totals in (("2026-08-20", (100, 180)), ("2026-08-21", (500, 620)), ("2026-08-22", (900,))):
        for i, t in enumerate(totals):
            summary = device_summary(today={"totalTokens": t})
            apply_ingest(db, summary)
            # 把快照时间改到指定天，简化测试
            db.execute("UPDATE tm_snapshots SET day=?, received_at=? WHERE id=("
                       "SELECT MAX(id) FROM tm_snapshots)",
                       (day, f"{day}T1{i}:00:00+00:00"))

    overview = client.get("/api/v1/tm/overview", headers=READ).json()
    days = {t["day"]: t["total"] for t in overview["trend"]}
    assert days == {"2026-08-20": 180, "2026-08-21": 620, "2026-08-22": 900}


def test_snapshot_retention_prunes_old_full_resolution(tmp_path):
    from hub.tm_hub import apply_ingest

    client = make_client(tmp_path)
    db = client.app.state.db
    apply_ingest(db, device_summary())
    # 造一批 8 天前的同日快照：只应保留每天最后一个
    from datetime import datetime, timedelta, timezone

    old_day = (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%d")
    for hour in range(6):
        db.execute(
            "INSERT INTO tm_snapshots (device_id, received_at, day, today_total) "
            "VALUES ('dev-old', ?, ?, 10)",
            (f"{old_day}T{hour:02d}:00:00+00:00", old_day),
        )
    apply_ingest(db, device_summary())  # 触发清理
    remaining = db.fetchall(
        "SELECT * FROM tm_snapshots WHERE day = ?", (old_day,)
    )
    assert len(remaining) == 1  # 当天只留最后一个
    # 400 天前的全删
    ancient = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%d")
    db.execute(
        "INSERT INTO tm_snapshots (device_id, received_at, day, today_total) "
        "VALUES ('x', ?, ?, 1)",
        (f"{ancient}T00:00:00+00:00", ancient),
    )
    apply_ingest(db, device_summary())
    assert db.fetchone("SELECT COUNT(*) n FROM tm_snapshots WHERE day=?", (ancient,))["n"] == 0


def test_tm_panel_served(tmp_path):
    # tm 面板目录约定与 frontend 同级：frontend_dir.parent / "tm-frontend"
    frontend_dir = tmp_path / "frontend"
    frontend_dir.mkdir()
    tm_dir = frontend_dir.parent / "tm-frontend"
    tm_dir.mkdir()
    (tm_dir / "index.html").write_text("<html>panel</html>", encoding="utf-8")

    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=frontend_dir,
        max_records_per_push=500,
        tm_ingest_secret=TM_SECRET,
    )
    client = TestClient(create_app(settings))
    resp = client.get("/tm/")
    assert resp.status_code == 200
    assert "panel" in resp.text


def test_openwebui_sync_untouched_alongside_tm(tmp_path):
    """tm 层与原有 openwebui 同步互不影响。"""
    client = make_client(tmp_path)
    client.post(
        "/api/v1/sync/push",
        json={
            "device": {"id": "owui-dev"},
            "source_instance_id": "src",
            "records": [
                {
                    "local_id": 1, "user_id": "u", "model_name": "m",
                    "input_tokens": 5, "output_tokens": 2,
                    "created_at": "2026-08-22T00:00:00+00:00",
                }
            ],
        },
        headers=AUTH,
    )
    client.post("/api/ingest", json=device_summary(), headers=TM_AUTH)
    assert client.get("/api/v1/records", headers=READ).json()["total"] == 1
    overview = client.get("/api/v1/tm/overview", headers=READ).json()
    assert overview["totals"]["today"]["totalTokens"] == 1000
