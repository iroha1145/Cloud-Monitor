"""Request boundaries must fail cleanly rather than raise server errors."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.config import Settings
from hub.main import create_app


def _deep_json() -> bytes:
    # About 20 KB: below the ingest byte limit but beyond the JSON recursion limit.
    return (b"[" * 10000) + (b"]" * 10000)


def test_deeply_nested_json_stays_client_error(tmp_path):
    settings = Settings(
        access_token="b" * 32,
        database_path=tmp_path / "nested.sqlite3",
        frontend_dir=tmp_path / "frontend",
        tm_background_enabled=False,
        tm_ingest_secret="c" * 32,
        tm_core_url="http://127.0.0.1:9",
    )
    body = _deep_json()
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        ingested = client.post("/api/ingest", content=body, headers={
            "X-Token-Monitor-Secret": "c" * 32,
            "Content-Type": "application/json",
        })
        assert ingested.status_code == 400
        assert ingested.json() == {"error": "bad_request", "message": "invalid json"}
        assert client.get("/api/v1/health/live").status_code == 200


def _nest(depth: int) -> dict:
    value: dict = {}
    for _ in range(depth):
        value = {"n": value}
    return value


@pytest.mark.parametrize(
    "extra, message",
    [
        ({"today": {"sessions": {"s1": {"outputTokens": -1}}}},
         "$.today.sessions.s1.outputTokens: 负数不被接受（-1）"),
        ({"today": {"sessions": {"s1": {"turns": [{"cacheReadTokens": 1.5}]}}}},
         "$.today.sessions.s1.turns[0].cacheReadTokens: token 数必须为整数（得到 1.5）"),
        ({"today": {"sessions": {"s1": {"totalTokens": "9"}}}},
         "$.today.sessions.s1.totalTokens: token 数必须是数字"),
        ({"history": {"daily": [{"date": "2026-02-30"}]}},
         "$.history.daily[0].date: 非法日期 '2026-02-30'"),
        ({"history": {"daily": [{}, {"costUsd": -2}]}},
         "$.history.daily[1].costUsd: 负金额不被接受"),
        ({"limits": {"providers": [{"windows": [{"resetsAt": 5}]}]}},
         "$.limits.providers[0].windows[0].resetsAt: 时间戳必须是字符串"),
        ({"extra": {"items": [{"lastUsedAt": "not-a-time"}]}},
         "$.extra.items[0].lastUsedAt: 非法时间戳 'not-a-time'"),
        ({"extra": {"__proto__": 1}}, "$.extra.__proto__: 原型敏感键被拒绝"),
        ({"extra": {"k" * 257: 1}}, "$.extra." + "k" * 257 + ": 键过长（>256）"),
        ({"extra": [[float("nan")]]}, "$.extra[0][0]: NaN/Infinity 不被接受"),
        ({"extra": _nest(12)}, "$.extra" + ".n" * 12 + ": JSON 嵌套超过 12 层"),
    ],
)
def test_ingest_validator_rejection_names_the_exact_path(extra, message):
    from hub.tm_validate import PayloadValidationError, validate_ingest_payload

    with pytest.raises(PayloadValidationError) as caught:
        validate_ingest_payload({"deviceId": "dev", **extra})
    assert str(caught.value) == message
