"""Request boundaries must fail cleanly rather than raise server errors."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.config import Settings
from hub.main import create_app


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        api_key="a" * 32, access_token="b" * 32,
        database_path=tmp_path / "boundaries.sqlite3",
        frontend_dir=tmp_path / "frontend", max_records_per_push=500,
        tm_background_enabled=False,
    )
    with TestClient(create_app(settings), raise_server_exceptions=False) as instance:
        yield instance


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "1e9999"])
def test_nonfinite_validation_input_returns_json_400(client, value):
    body = ('{"device":{"id":"dev"},"records":[{"local_id":1,"user_id":"u",'
            '"input_tokens":' + value + ',"created_at":"2026-08-01T00:00:00Z"}]}')
    response = client.post("/api/v1/sync/push", content=body, headers={
        "Authorization": "Bearer " + "a" * 32, "Content-Type": "application/json",
    })
    assert response.status_code == 400
    error = response.json()
    assert error["error"] == "请求体校验失败"
    assert error["details"][0]["loc"] == ["body", "records", 0, "input_tokens"]
    assert set(error["details"][0]) == {"type", "loc", "msg"}
    assert client.app.state.db.fetchone("SELECT COUNT(*) AS n FROM devices")["n"] == 0
    assert client.get("/api/v1/health/live").status_code == 200


def test_nested_invalid_input_is_not_reflected_in_error_response(client):
    response = client.post("/api/v1/sync/push", json={
        "device": {"id": "dev"}, "records": [{
            "local_id": 1, "user_id": "u", "created_at": "2026-08-01T00:00:00Z",
            "input_tokens": {"private-note": "not-for-error-output"},
        }],
    }, headers={"Authorization": "Bearer " + "a" * 32})
    assert response.status_code == 400
    assert "not-for-error-output" not in response.text
    assert response.json()["details"][0]["type"] == "int_type"


EXTREME_DATES = ["0001-01-01T00:00:00+14:00", "9999-12-31T23:59:59-12:00"]


@pytest.mark.parametrize("stamp", EXTREME_DATES)
def test_sync_rejects_timezone_conversion_overflow(client, stamp):
    response = client.post("/api/v1/sync/push", json={
        "device": {"id": "dev"},
        "records": [{"local_id": 1, "user_id": "u", "created_at": stamp}],
    }, headers={"Authorization": "Bearer " + "a" * 32})
    assert response.status_code == 400
    assert response.json()["details"][0]["loc"] == ["body", "records", 0, "created_at"]
    assert client.app.state.db.fetchone("SELECT COUNT(*) AS n FROM devices")["n"] == 0


@pytest.mark.parametrize("stamp", EXTREME_DATES)
@pytest.mark.parametrize("endpoint", ["usage", "users", "records"])
def test_read_filters_reject_timezone_conversion_overflow(client, stamp, endpoint):
    response = client.get("/api/v1/" + endpoint, params={"start_time": stamp},
                          headers={"Authorization": "Bearer " + "b" * 32})
    assert response.status_code == 400
    assert isinstance(response.json()["error"], str)


def test_valid_offset_timestamps_still_roundtrip(client):
    response = client.post("/api/v1/sync/push", json={
        "device": {"id": "dev"}, "records": [{
            "local_id": 1, "user_id": "u", "input_tokens": 10,
            "created_at": "2026-08-01T09:30:00+09:00",
        }],
    }, headers={"Authorization": "Bearer " + "a" * 32})
    assert response.status_code == 200
    response = client.get("/api/v1/records", params={
        "start_time": "2026-08-01T09:30:00+09:00", "end_time": "2026-08-01T00:30:00Z",
    }, headers={"Authorization": "Bearer " + "b" * 32})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["records"][0]["created_at"] == "2026-08-01T00:30:00+00:00"


def test_oversized_page_returns_empty_page_without_sqlite_integer_overflow(client):
    response = client.get("/api/v1/records", params={"page": 2**63, "page_size": 200},
                          headers={"Authorization": "Bearer " + "b" * 32})
    assert response.status_code == 200
    assert response.json()["records"] == []
    assert response.json()["total"] == 0
