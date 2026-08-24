from __future__ import annotations

import json
import queue
import sqlite3
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hub.config import ConfigError, Settings, load_settings
from hub.db import Database
from hub.main import create_app
from hub.models import DeviceInfo, RecordIn, SyncPushRequest, UserIn
from hub.services import apply_sync_push

API_KEY = "unit-test-admin-key"
READ_KEY = "unit-test-read-key"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def make_settings(tmp_path, **overrides) -> Settings:
    defaults = dict(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=tmp_path / "no-frontend",
        max_records_per_push=500,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture()
def client(settings) -> TestClient:
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


def push_payload(device_id="dev-1", local_ids=(1, 2), source="src-1", **overrides):
    payload = {
        "device": {"id": device_id, "name": "MacBook", "platform": "darwin"},
        "source_instance_id": source,
        "users": [
            {
                "id": "u1",
                "name": "Alice",
                "email": "a@x.com",
                "role": "admin",
            }
        ],
        "records": [
            {
                "local_id": i,
                "user_id": "u1",
                "nickname": "Alice",
                "model_name": "gpt-4o",
                "input_tokens": 10 * i,
                "output_tokens": 5 * i,
                "created_at": f"2026-08-01T00:00:{i:02d}+00:00",
            }
            for i in local_ids
        ],
    }
    payload.update(overrides)
    return payload


# ================================================================ 原有 8 项（语义保留）


def test_push_and_read_roundtrip(client: TestClient):
    resp = client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["inserted"] == 2 and body["success"] is True
    assert body["protocol_version"] == 2
    assert body["received"] == 2

    usage = client.get("/api/v1/usage", headers=READ).json()
    assert usage["totals"]["calls"] == 2
    assert usage["totals"]["total_tokens"] == (10 + 5) + (20 + 10)
    assert usage["by_model"][0]["model_name"] == "gpt-4o"
    assert usage["by_device"][0]["device_id"] == "dev-1"

    users = client.get("/api/v1/users", headers=READ).json()
    assert users["total"] == 1
    assert users["users"][0]["name"] == "Alice"
    assert users["users"][0]["calls"] == 2

    records = client.get("/api/v1/records", headers=READ).json()
    assert records["total"] == 2
    assert records["records"][0]["device_id"] == "dev-1"
    assert records["records"][0]["local_id"] == 2  # 按时间倒序

    devices = client.get("/api/v1/devices", headers=READ).json()
    assert devices["total"] == 1
    assert devices["devices"][0]["record_count"] == 2
    assert devices["devices"][0]["total_tokens"] == 45


def test_push_is_idempotent(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH)
    again = client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH).json()
    assert again["inserted"] == 0
    assert again["duplicates"] == 2
    assert again["conflicts"] == 0
    assert client.get("/api/v1/records", headers=READ).json()["total"] == 2


def test_same_local_id_different_device_both_kept(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload("dev-1"), headers=AUTH)
    client.post("/api/v1/sync/push", json=push_payload("dev-2"), headers=AUTH)
    assert client.get("/api/v1/records", headers=READ).json()["total"] == 4
    devices = client.get("/api/v1/devices", headers=READ).json()
    assert devices["total"] == 2


def test_push_requires_auth(client: TestClient):
    assert client.post("/api/v1/sync/push", json=push_payload()).status_code == 401


def test_push_rejects_bad_payload(client: TestClient):
    no_device = push_payload()
    no_device["device"] = {}
    assert client.post("/api/v1/sync/push", json=no_device, headers=AUTH).status_code == 400

    bad_record = push_payload()
    bad_record["records"][0].pop("local_id")
    assert client.post("/api/v1/sync/push", json=bad_record, headers=AUTH).status_code == 400


def test_push_enforces_batch_limit(tmp_path):
    settings = make_settings(tmp_path, max_records_per_push=2)
    app = create_app(settings)
    client = TestClient(app)
    oversized = push_payload(local_ids=(1, 2, 3))
    resp = client.post("/api/v1/sync/push", json=oversized, headers=AUTH)
    assert resp.status_code == 400
    assert "records" in resp.json()["error"]


def test_records_filter_by_device(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload("dev-1"), headers=AUTH)
    client.post("/api/v1/sync/push", json=push_payload("dev-2"), headers=AUTH)
    only1 = client.get("/api/v1/records", params={"device_id": "dev-1"}, headers=READ).json()
    assert only1["total"] == 2
    assert all(r["device_id"] == "dev-1" for r in only1["records"])


def test_invalid_created_at_rejected(client: TestClient):
    """非法时间戳必须 400，不得静默替换为服务器时间。"""
    bad = push_payload(local_ids=(9,))
    bad["records"][0]["created_at"] = "not-a-date"
    resp = client.post("/api/v1/sync/push", json=bad, headers=AUTH)
    assert resp.status_code == 400
    far_future = push_payload(local_ids=(10,))
    far_future["records"][0]["created_at"] = "2100-01-01T00:00:00+00:00"
    assert client.post("/api/v1/sync/push", json=far_future, headers=AUTH).status_code == 400


# ================================================================ 一、并发与事务


def _push_model(device_id: str, source: str, start: int, count: int) -> SyncPushRequest:
    return SyncPushRequest(
        device=DeviceInfo(id=device_id, name="load", platform="test"),
        source_instance_id=source,
        users=[UserIn(id="u-load", name="loader")],
        records=[
            RecordIn(
                local_id=start + i + 1,
                user_id="u-load",
                model_name="m",
                input_tokens=1,
                output_tokens=1,
                created_at="2026-08-01T00:00:00+00:00",
            )
            for i in range(count)
        ],
    )


def test_concurrent_push_32_threads_200_batches(tmp_path):
    """32 线程 × 200 批 × 100 条 = 20000，零异常、恰好 20000 行。"""
    settings = make_settings(tmp_path)
    app = create_app(settings)
    db = app.state.db

    batches = queue.Queue()
    for b in range(200):
        batches.put((f"dev-{b % 4}", f"src-{b % 8}", b * 100, 100))
    errors: list[Exception] = []
    barrier = threading.Barrier(32)

    def worker():
        try:
            barrier.wait(timeout=30)
            while True:
                try:
                    device_id, source, start, count = batches.get_nowait()
                except queue.Empty:
                    return
                apply_sync_push(
                    db, _push_model(device_id, source, start, count), protocol_version=2
                )
        except Exception as exc:  # noqa: BLE001 — 记录一切异常
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(32)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    assert errors == [], f"并发写入出现异常: {errors[:3]}"
    total = db.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"]
    assert total == 20000, f"期望 20000 条，实际 {total}"


def test_transaction_rollback_leaves_no_partial_state(tmp_path, monkeypatch):
    """批次中注入异常 → device/user/record 全部回滚，无半批数据。"""
    settings = make_settings(tmp_path)
    app = create_app(settings)
    db = app.state.db

    original = db.executemany

    def exploding_executemany(sql, seq):
        raise sqlite3.IntegrityError("injected failure")

    payload = _push_model("dev-rb", "src-rb", 1, 3)
    monkeypatch.setattr(db, "executemany", exploding_executemany)
    with pytest.raises(sqlite3.IntegrityError):
        apply_sync_push(db, payload, protocol_version=2)
    monkeypatch.setattr(db, "executemany", original)

    assert db.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"] == 0
    assert db.fetchone("SELECT COUNT(*) AS n FROM devices WHERE id='dev-rb'")["n"] == 0
    assert db.fetchone("SELECT COUNT(*) AS n FROM users WHERE id='u-load'")["n"] == 0
    assert not db._conn.in_transaction


# ================================================================ 二、迁移与数据源实例


def _make_v0_database(path: Path) -> None:
    """构造 v1 时期的旧库：无 source_instance_id/fingerprint，旧唯一索引。"""
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
            platform TEXT NOT NULL DEFAULT '', agent_version TEXT NOT NULL DEFAULT '',
            first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL, local_id INTEGER NOT NULL, user_id TEXT NOT NULL,
            nickname TEXT NOT NULL DEFAULT '', model_name TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX idx_records_device_local ON usage_records(device_id, local_id);
        INSERT INTO devices VALUES ('old-dev','Old','','','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');
        INSERT INTO users VALUES ('u1','','Alice','user','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');
        INSERT INTO usage_records (device_id, local_id, user_id, nickname, model_name,
            input_tokens, output_tokens, created_at)
        VALUES ('old-dev', 1, 'u1', 'Alice', 'gpt-4o', 100, 50, '2026-01-02T00:00:00+00:00'),
               ('old-dev', 2, 'u1', 'Alice', 'gpt-4o', 7, 3, '2026-01-03T00:00:00+00:00');
        """
    )
    conn.commit()
    conn.execute("PRAGMA user_version = 0")
    conn.commit()
    conn.close()


def test_migration_preserves_data_and_swaps_unique_index(tmp_path):
    db_path = tmp_path / "old.sqlite3"
    _make_v0_database(db_path)

    db = Database(db_path)  # 触发迁移
    assert db.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"] == 2
    rows = db.fetchall("SELECT * FROM usage_records")
    assert all(r["source_instance_id"] == "legacy" for r in rows)
    assert all(r["fingerprint"] != "" for r in rows)  # 指纹已回填

    indexes = {
        r["name"]
        for r in db._conn.execute("PRAGMA index_list(usage_records)").fetchall()
    }
    assert "idx_records_device_local" not in indexes
    assert "idx_records_device_source_local" in indexes
    assert db.fetchone("PRAGMA user_version")["user_version"] == 2

    # 同内容重推（legacy 源）应命中 duplicates 而非 conflicts
    result = apply_sync_push(
        db,
        SyncPushRequest(
            device=DeviceInfo(id="old-dev"),
            source_instance_id="legacy",
            users=[],
            records=[
                RecordIn(
                    local_id=1, user_id="u1", nickname="Alice", model_name="gpt-4o",
                    input_tokens=100, output_tokens=50,
                    created_at="2026-01-02T00:00:00+00:00",
                )
            ],
        ),
        protocol_version=2,
    )
    assert result["duplicates"] == 1 and result["conflicts"] == 0
    db.close()


def test_migration_idempotent_on_reopen(tmp_path):
    db_path = tmp_path / "old.sqlite3"
    _make_v0_database(db_path)
    db1 = Database(db_path)
    count1 = db1.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"]
    db1.close()

    db2 = Database(db_path)  # 第二次打开重复迁移
    count2 = db2.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"]
    assert count1 == count2 == 2
    db2.close()


def test_local_id_reuse_with_new_source_instance(tmp_path):
    """本地库重建后 local_id 从 1 重新计数：新 source_instance 下全部保留。"""
    settings = make_settings(tmp_path)
    app = create_app(settings)
    db = app.state.db
    apply_sync_push(db, _push_model("dev-1", "src-old", 1, 3), protocol_version=2)
    result = apply_sync_push(db, _push_model("dev-1", "src-new", 1, 3), protocol_version=2)
    assert result["inserted"] == 3
    assert db.fetchone("SELECT COUNT(*) AS n FROM usage_records")["n"] == 6


def test_content_conflict_detected_not_swallowed(client: TestClient):
    first = push_payload(local_ids=(1,))
    client.post("/api/v1/sync/push", json=first, headers=AUTH)
    conflicting = push_payload(local_ids=(1,))
    conflicting["records"][0]["input_tokens"] = 999
    resp = client.post("/api/v1/sync/push", json=conflicting, headers=AUTH).json()
    assert resp["conflicts"] == 1
    assert resp["inserted"] == 0
    # 云端保留原数据
    rec = client.get("/api/v1/records", headers=READ).json()["records"][0]
    assert rec["input_tokens"] == 10


# ================================================================ 四、心跳与用户保真


def test_heartbeat_updates_last_seen_without_records(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH)
    seen1 = client.get("/api/v1/devices", headers=READ).json()["devices"][0]["last_seen_at"]
    time.sleep(1.1)
    beat = {
        "device": {"id": "dev-1", "name": "MacBook"},
        "source_instance_id": "src-1",
        "users": [{"id": "u1", "name": "Alice-改名", "role": "admin"}],
        "records": [],
    }
    resp = client.post("/api/v1/sync/push", json=beat, headers=AUTH).json()
    assert resp["received"] == 0 and resp["success"] is True
    device = client.get("/api/v1/devices", headers=READ).json()["devices"][0]
    assert device["last_seen_at"] > seen1
    # 心跳携带的 users 生效（改名同步）
    user = client.get("/api/v1/users", headers=READ).json()["users"][0]
    assert user["name"] == "Alice-改名"


def test_user_created_at_preserved_on_update(client: TestClient):
    client.post(
        "/api/v1/sync/push",
        json=push_payload(
            users=[
                {
                    "id": "u1",
                    "name": "Alice",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            ],
            local_ids=(1,),
        ),
        headers=AUTH,
    )
    client.post(
        "/api/v1/sync/push",
        json={
            "device": {"id": "dev-1"},
            "source_instance_id": "src-1",
            "users": [
                {
                    "id": "u1",
                    "name": "Alice2",
                    "created_at": "2099-12-31T00:00:00+00:00",
                    "updated_at": "2026-08-22T00:00:00+00:00",
                }
            ],
            "records": [],
        },
        headers=AUTH,
    )
    user = client.get("/api/v1/users", headers=READ).json()["users"][0]
    assert user["created_at"] == "2026-01-01T00:00:00+00:00"  # 原始时间不被覆盖
    assert user["name"] == "Alice2"
    assert user["updated_at"] == "2026-08-22T00:00:00+00:00"


# ================================================================ 五、SQL 分页与聚合


def _seed_large(db: Database, n: int) -> None:
    rows = []
    for i in range(1, n + 1):
        rows.append(
            (
                "dev-bench",
                "src-bench",
                i,
                f"u{i % 50}",
                f"nick-{i % 50}",
                f"model-{i % 7}",
                i % 1000,
                (i * 7) % 500,
                f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}T12:00:00+00:00",
            )
        )
    with db.transaction():
        db.execute(
            "INSERT INTO devices VALUES ('dev-bench','bench','test','','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')"
        )
        for i in range(0, n, 10000):
            db.executemany(
                """
                INSERT INTO usage_records (
                    device_id, source_instance_id, local_id, user_id, nickname,
                    model_name, input_tokens, output_tokens, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows[i : i + 10000],
            )


@pytest.fixture(scope="module")
def large_app(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("bench")
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp / "bench.sqlite3",
        frontend_dir=tmp,
        max_records_per_push=500,
    )
    app = create_app(settings)
    _seed_large(app.state.db, 100_000)
    yield app
    app.state.db.close()


def test_records_sql_pagination_on_100k(large_app):
    client = TestClient(large_app)
    data = client.get("/api/v1/records", params={"page_size": 20}, headers=READ).json()
    assert data["total"] == 100_000
    assert len(data["records"]) == 20  # 首页只取 20 条，不整表加载
    deep = client.get(
        "/api/v1/records", params={"page_size": 20, "page": 4000}, headers=READ
    ).json()
    assert len(deep["records"]) == 20
    # 深页时间序必然不晚于首页（ORDER BY created_at DESC, id DESC）
    assert deep["records"][0]["created_at"] <= data["records"][0]["created_at"]


def test_usage_sql_aggregation_matches_python_baseline(large_app):
    client = TestClient(large_app)
    started = time.monotonic()
    usage = client.get("/api/v1/usage", headers=READ).json()
    elapsed = time.monotonic() - started

    db = large_app.state.db
    rows = db.fetchall("SELECT * FROM usage_records")
    by_user: dict[str, int] = {}
    by_model: dict[str, int] = {}
    totals = {"in": 0, "out": 0}
    for r in rows:
        totals["in"] += r["input_tokens"]
        totals["out"] += r["output_tokens"]
        by_user[r["user_id"]] = by_user.get(r["user_id"], 0) + r["input_tokens"] + r["output_tokens"]
        by_model[r["model_name"]] = by_model.get(r["model_name"], 0) + r["input_tokens"] + r["output_tokens"]

    assert usage["totals"]["calls"] == len(rows) == 100_000
    assert usage["totals"]["input_tokens"] == totals["in"]
    assert usage["totals"]["output_tokens"] == totals["out"]
    assert usage["totals"]["distinct_users"] == len(by_user)
    assert usage["totals"]["distinct_models"] == len(by_model)
    assert {u["user_id"]: u["total_tokens"] for u in usage["by_user"]} == by_user
    assert {m["model_name"]: m["total_tokens"] for m in usage["by_model"]} == by_model
    assert elapsed < 10, f"聚合耗时异常: {elapsed:.2f}s"


def test_by_user_nickname_uses_latest_identity(client: TestClient):
    """昵称取用户表当前值，不再倒序遍历留下最旧昵称。"""
    # 三条记录昵称逐渐变化，但用户表现名是最终身份
    for i, nick in enumerate(("Old-Nick", "Mid-Nick", ""), start=1):
        client.post(
            "/api/v1/sync/push",
            json={
                "device": {"id": "dev-1"},
                "source_instance_id": "src-1",
                "users": [{"id": "u1", "name": "New-Alice" if i == 3 else "旧名"}],
                "records": [
                    {
                        "local_id": i,
                        "user_id": "u1",
                        "nickname": nick,
                        "model_name": "m",
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "created_at": f"2026-08-0{i}T00:00:00+00:00",
                    }
                ],
            },
            headers=AUTH,
        )
    usage = client.get("/api/v1/usage", headers=READ).json()
    assert usage["by_user"][0]["nickname"] == "New-Alice"


def test_start_after_end_rejected(client: TestClient):
    resp = client.get(
        "/api/v1/records",
        params={"start_time": "2026-08-22", "end_time": "2026-08-21"},
        headers=READ,
    )
    assert resp.status_code == 400


# ================================================================ 六、鉴权与输入校验


def test_weak_api_key_rejected_at_startup(monkeypatch, tmp_path):
    for weak in ("", "changeme", "please-change-me", "short"):
        monkeypatch.setenv("API_KEY", weak)
        monkeypatch.setenv("ACCESS_TOKEN", "")
        monkeypatch.setenv("DATABASE_PATH", str(tmp_path / f"{len(weak)}.db"))
        with pytest.raises(ConfigError):
            load_settings()


def test_shared_token_requires_opt_in(monkeypatch, tmp_path):
    monkeypatch.setenv("API_KEY", "a" * 32)
    monkeypatch.setenv("ACCESS_TOKEN", "")
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "a.db"))
    monkeypatch.setenv("ALLOW_SHARED_TOKEN", "")
    with pytest.raises(ConfigError):
        load_settings()
    monkeypatch.setenv("ALLOW_SHARED_TOKEN", "true")
    settings = load_settings()
    assert settings.access_token == settings.api_key


def test_device_keys_json_validation(monkeypatch, tmp_path):
    monkeypatch.setenv("API_KEY", "a" * 32)
    monkeypatch.setenv("ACCESS_TOKEN", "b" * 32)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "c.db"))
    monkeypatch.setenv("DEVICE_KEYS_JSON", "{not json")
    with pytest.raises(ConfigError):
        load_settings()
    monkeypatch.setenv("DEVICE_KEYS_JSON", json.dumps({"d1": "k" * 32, "d2": "k" * 32}))
    with pytest.raises(ConfigError):  # 重复密钥值
        load_settings()
    monkeypatch.setenv("DEVICE_KEYS_JSON", json.dumps({"d1": "short"}))
    with pytest.raises(ConfigError):  # 32 字符下限
        load_settings()
    monkeypatch.setenv("DEVICE_KEYS_JSON", json.dumps({"d1": "d" * 32}))
    settings = load_settings()
    assert settings.device_keys == {"d1": "d" * 32}


def test_keys_mutual_exclusion(monkeypatch, tmp_path):
    monkeypatch.setenv("API_KEY", "a" * 32)
    monkeypatch.setenv("ACCESS_TOKEN", "a" * 32)  # 与 API_KEY 相同且未显式放行
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "m.db"))
    with pytest.raises(ConfigError):
        load_settings()
    monkeypatch.setenv("ACCESS_TOKEN", "b" * 32)
    monkeypatch.setenv("TOKEN_MONITOR_SECRET", "b" * 32)  # 与 ACCESS_TOKEN 相同
    with pytest.raises(ConfigError):
        load_settings()
    monkeypatch.setenv("TOKEN_MONITOR_SECRET", "t" * 32)
    assert load_settings().tm_ingest_secret == "t" * 32


def test_device_key_cannot_impersonate_other_device(tmp_path):
    settings = make_settings(tmp_path, device_keys={"dev-a": "device-a-key"})
    client = TestClient(create_app(settings))
    ok = client.post(
        "/api/v1/sync/push",
        json=push_payload("dev-a", local_ids=(1,)),
        headers={"Authorization": "Bearer device-a-key"},
    )
    assert ok.status_code == 200
    cross = client.post(
        "/api/v1/sync/push",
        json=push_payload("dev-b", local_ids=(1,)),
        headers={"Authorization": "Bearer device-a-key"},
    )
    assert cross.status_code == 403
    # 设备密钥不能当只读密钥用
    denied = client.get(
        "/api/v1/records", headers={"Authorization": "Bearer device-a-key"}
    )
    assert denied.status_code == 401


def test_strict_token_validation(client: TestClient):
    for bad in (True, -1, 1.5, "10"):
        payload = push_payload(local_ids=(77,))
        payload["records"][0]["input_tokens"] = bad
        resp = client.post("/api/v1/sync/push", json=payload, headers=AUTH)
        assert resp.status_code == 400, f"{bad!r} 应被拒绝"


def test_body_size_limit(tmp_path):
    settings = make_settings(tmp_path, max_sync_body_bytes=1000)
    client = TestClient(create_app(settings))
    payload = push_payload(local_ids=tuple(range(1, 60)))
    resp = client.post("/api/v1/sync/push", json=payload, headers=AUTH)
    assert resp.status_code == 413


def test_cors_and_docs_disabled_by_default(client: TestClient):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    resp = client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in resp.headers


def test_docs_enabled_opt_in(tmp_path):
    settings = make_settings(tmp_path, docs_enabled=True)
    client = TestClient(create_app(settings))
    assert client.get("/docs").status_code == 200


def test_shutdown_closes_database(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings)
    with TestClient(app):
        pass
    assert app.state.db._closed


def test_live_root_hides_demo_route(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe)
    with TestClient(create_app(settings)) as client:
        root = client.get("/")
        assert root.status_code == 200
        assert "LIVE-INDEX" in root.text
        assert client.get("/demo").status_code == 404


def test_cm_demo_serves_demo_at_root(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe, cm_demo=True)
    with TestClient(create_app(settings)) as client:
        root = client.get("/")
        assert root.status_code == 200
        assert "DEMO-INDEX" in root.text


def test_serve_demo_route_keeps_live_root(tmp_path):
    fe = tmp_path / "fe"
    fe.mkdir()
    (fe / "index.html").write_text("LIVE-INDEX", encoding="utf-8")
    (fe / "demo.html").write_text("DEMO-INDEX", encoding="utf-8")
    settings = make_settings(tmp_path, frontend_dir=fe, serve_demo_route=True)
    with TestClient(create_app(settings)) as client:
        assert "LIVE-INDEX" in client.get("/").text
        demo = client.get("/demo")
        assert demo.status_code == 200
        assert "DEMO-INDEX" in demo.text
