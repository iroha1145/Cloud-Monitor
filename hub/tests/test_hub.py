from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.config import Settings
from hub.db import Database
from hub.main import create_app
from hub.services import apply_sync_push


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        api_key="secret-key",
        access_token="",
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=tmp_path / "no-frontend",
        max_records_per_push=500,
    )


@pytest.fixture()
def client(settings) -> TestClient:
    app = create_app(settings)
    return TestClient(app)


def push_payload(device_id="dev-1", local_ids=(1, 2), **overrides):
    payload = {
        "device": {"id": device_id, "name": "MacBook", "platform": "darwin"},
        "users": [{"id": "u1", "name": "Alice", "email": "a@x.com", "role": "admin"}],
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


AUTH = {"Authorization": "Bearer secret-key"}


def test_push_and_read_roundtrip(client: TestClient):
    resp = client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["inserted"] == 2 and body["success"] is True

    usage = client.get("/api/v1/usage", headers=AUTH).json()
    assert usage["totals"]["calls"] == 2
    assert usage["totals"]["total_tokens"] == (10 + 5) + (20 + 10)
    assert usage["by_model"][0]["model_name"] == "gpt-4o"
    assert usage["by_device"][0]["device_id"] == "dev-1"

    users = client.get("/api/v1/users", headers=AUTH).json()
    assert users["total"] == 1
    assert users["users"][0]["name"] == "Alice"
    assert users["users"][0]["calls"] == 2

    records = client.get("/api/v1/records", headers=AUTH).json()
    assert records["total"] == 2
    assert records["records"][0]["device_id"] == "dev-1"
    assert records["records"][0]["local_id"] == 2  # 按时间倒序

    devices = client.get("/api/v1/devices", headers=AUTH).json()
    assert devices["total"] == 1
    assert devices["devices"][0]["record_count"] == 2
    assert devices["devices"][0]["total_tokens"] == 45


def test_push_is_idempotent(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH)
    again = client.post("/api/v1/sync/push", json=push_payload(), headers=AUTH).json()
    assert again["inserted"] == 0
    assert again["skipped"] == 2
    assert client.get("/api/v1/records", headers=AUTH).json()["total"] == 2


def test_same_local_id_different_device_both_kept(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload("dev-1"), headers=AUTH)
    client.post("/api/v1/sync/push", json=push_payload("dev-2"), headers=AUTH)
    assert client.get("/api/v1/records", headers=AUTH).json()["total"] == 4
    devices = client.get("/api/v1/devices", headers=AUTH).json()
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
    settings = Settings(
        api_key="secret-key",
        access_token="",
        database_path=tmp_path / "h.sqlite3",
        frontend_dir=tmp_path,
        max_records_per_push=2,
    )
    app = create_app(settings)
    client = TestClient(app)
    oversized = push_payload(local_ids=(1, 2, 3))
    resp = client.post("/api/v1/sync/push", json=oversized, headers=AUTH)
    assert resp.status_code == 400
    assert "records" in resp.json()["error"]


def test_records_filter_by_device(client: TestClient):
    client.post("/api/v1/sync/push", json=push_payload("dev-1"), headers=AUTH)
    client.post("/api/v1/sync/push", json=push_payload("dev-2"), headers=AUTH)
    only1 = client.get(
        "/api/v1/records", params={"device_id": "dev-1"}, headers=AUTH
    ).json()
    assert only1["total"] == 2
    assert all(r["device_id"] == "dev-1" for r in only1["records"])


def test_apply_sync_push_defaults_created_at(tmp_path):
    db = Database(":memory:")
    result = apply_sync_push(
        db, {"device": {"id": "d"}, "records": [{"local_id": 1, "user_id": "u"}]},
        max_records=10,
    )
    assert result["inserted"] == 1
    row = db.fetchone("SELECT created_at FROM usage_records")
    assert row["created_at"]  # 服务器时间兜底
