"""New-client negotiation must not weaken durable acknowledgement or old clients."""

from __future__ import annotations

import copy
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import READ_KEY, TM_SECRET, make_settings, widget_style_payload
from hub import tm_forwarding, tm_outbox
from hub.main import create_app
from hub.tm_overview import _collect_sessions
from hub.tm_proxy import UpstreamUnavailable

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
MINIMAL = {**HEADERS, "X-Token-Monitor-Response": "minimal"}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def test_minimal_ingest_retains_full_ack_and_snapshot_even_on_duplicate(cloud):
    payload = widget_style_payload("v062-minimal")
    for _ in range(2):
        response = cloud.post("/api/ingest", json=payload, headers=MINIMAL)
        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True, "deviceId": payload["deviceId"]}
    db = cloud.app.state.db
    rows = db.fetchall("SELECT * FROM tm_ingest_outbox WHERE device_id=?", (payload["deviceId"],))
    assert len(rows) == 1
    row = rows[0]
    assert row["state"] == "done"
    assert row["forward_payload_json"] is None
    assert json.loads(row["normalized_json"])["periods"]["today"]["totalTokens"] == payload["today"]["totalTokens"]
    snapshot = db.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id=?", (payload["deviceId"],))
    assert snapshot["today_total"] == payload["today"]["totalTokens"]


def test_minimal_ingest_keeps_confirmed_record_for_snapshot_replay(cloud, monkeypatch):
    def locked(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(tm_forwarding, "write_snapshot", locked)
    payload = widget_style_payload("v062-replay")
    response = cloud.post("/api/ingest", json=payload, headers=MINIMAL)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "deviceId": payload["deviceId"]}
    db = cloud.app.state.db
    row = db.fetchone("SELECT state, normalized_json FROM tm_ingest_outbox")
    assert row["state"] == "pending"
    assert json.loads(row["normalized_json"])["periods"]["today"]["totalTokens"] == payload["today"]["totalTokens"]
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0
    tm_outbox.replay_pending(db, cloud.app.state.tm_core)
    assert db.fetchone("SELECT state FROM tm_ingest_outbox")["state"] == "done"
    assert db.fetchone("SELECT today_total FROM tm_snapshot_buckets")["today_total"] == payload["today"]["totalTokens"]


def test_minimal_never_turns_unconfirmed_upload_into_success(cloud, monkeypatch):
    def offline(*_args, **_kwargs):
        raise UpstreamUnavailable("synthetic offline core")

    monkeypatch.setattr(cloud.app.state.tm_core, "request", offline)
    response = cloud.post("/api/ingest", json=widget_style_payload("v062-offline"), headers=MINIMAL)
    assert response.status_code == 503
    assert response.json()["error"] == "upstream_unavailable"
    assert "Retry-After" in response.headers
    assert cloud.app.state.db.fetchone("SELECT normalized_json FROM tm_ingest_outbox")["normalized_json"] is None


@pytest.mark.parametrize("header", [None, "full", "unknown-version"])
def test_clients_without_minimal_keep_full_ingest_response(cloud, header):
    headers = {**HEADERS, **({"X-Token-Monitor-Response": header} if header else {})}
    response = cloud.post("/api/ingest", json=widget_style_payload("v062-full"), headers=headers)
    assert response.status_code == 200
    assert response.json()["stats"]["devices"][0]["deviceId"] == "v062-full"


def test_session_observations_reach_overview_with_absence_preserved(cloud):
    payload = widget_style_payload("v062-session")
    session = {"client": "codex", "sessionId": "observed", "totalTokens": 100, "lastUsedAt": payload["updatedAt"]}
    session.update(contextTokens=1234, contextWindow=128000, turnEnded=False, sessionKind="background-review")
    payload["today"]["sessions"] = {"codex:observed": session}
    assert cloud.post("/api/ingest", json=payload, headers=MINIMAL).status_code == 200
    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    observed = next(row for row in overview["sessions"] if row["sessionId"] == session["sessionId"])
    assert {key: observed[key] for key in ("contextTokens", "contextWindow", "turnEnded", "sessionKind", "deviceStale")} == {
        "contextTokens": 1234, "contextWindow": 128000, "turnEnded": False,
        "sessionKind": "background-review", "deviceStale": False,
    }
    legacy = {"client": "codex", "sessionId": "old", "totalTokens": 100}
    stats = {"devices": [{"deviceId": "old-device", "periods": {"today": {"sessions": {"codex:old": legacy}}}}]}
    row = _collect_sessions(stats)[1][0]
    assert all(key not in row for key in ("contextTokens", "contextWindow", "turnEnded", "sessionKind", "deviceStale"))
    legacy.update(archived=True, turnEnded=False)
    row = _collect_sessions(stats)[1][0]
    assert row["archived"] is True
    assert row["turnEnded"] is False


@pytest.mark.parametrize("accept,compressed", [("gzip", True), ("GZip;q=1", True), ("*;q=0.5", True), ("gzip;q=0, *;q=1", False), ("identity", False)])
def test_json_compression_negotiation_preserves_stats(cloud, accept, compressed):
    payload = widget_style_payload("v062-compression")
    cloud.post("/api/ingest", json=payload, headers=HEADERS)
    response = cloud.get("/api/stats", headers={**HEADERS, "Accept-Encoding": accept})
    assert response.status_code == 200
    assert (response.headers.get("content-encoding") == "gzip") is compressed
    assert response.json()["periods"]["today"]["totalTokens"] == payload["today"]["totalTokens"]
    assert "accept-encoding" in response.headers.get("vary", "").lower()


def test_cors_accepts_new_headers_only_for_configured_origins(tmp_path):
    app = create_app(make_settings(tmp_path, cors_origins=("https://dashboard.example",)))
    with TestClient(app) as client:
        for origin, expected in [("https://dashboard.example", 200), ("https://other.example", 400)]:
            response = client.options("/api/ingest", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-token-monitor-secret,x-token-monitor-response,x-token-monitor-stream",
            })
            assert response.status_code == expected


def test_repeated_encoding_headers_preserve_explicit_gzip_veto(cloud):
    payload = widget_style_payload("v062-encoding-fields")
    cloud.post("/api/ingest", json=payload, headers=HEADERS)
    response = cloud.get("/api/stats", headers=[
        *HEADERS.items(), ("Accept-Encoding", "*;q=1"), ("Accept-Encoding", "gzip;q=0"),
    ])
    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    assert response.json()["periods"]["today"]["totalTokens"] == payload["today"]["totalTokens"]


def _sse_frame(lines):
    event = ""
    for line in lines:
        if line.startswith("event:"):
            event = line.partition(":")[2].strip()
        elif line.startswith("data:"):
            return event, json.loads(line.partition(":")[2])
    raise AssertionError("event stream ended before a frame")


@pytest.mark.parametrize("version,event", [("2", "freshness"), (None, "stats"), ("999", "stats")])
def test_stream_v2_is_opt_in_and_never_compressed(live_stack, version, event):
    device_id = f"v062-stream-{version}"
    payload = widget_style_payload(device_id)
    response = httpx.post(f"{live_stack.url}/api/ingest", json=payload, headers=MINIMAL)
    assert response.status_code == 200
    headers = {**HEADERS, "Accept-Encoding": "gzip"}
    if version:
        headers["X-Token-Monitor-Stream"] = version
    with httpx.stream("GET", f"{live_stack.url}/api/stats/stream", headers=headers, timeout=5) as response:
        assert response.status_code == 200
        assert "content-encoding" not in response.headers
        assert response.headers["x-accel-buffering"] == "no"
        lines = response.iter_lines()
        assert _sse_frame(lines)[0] == "snapshot"
        heartbeat = copy.deepcopy(payload)
        heartbeat["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        accepted = httpx.post(f"{live_stack.url}/api/ingest", json=heartbeat, headers=MINIMAL)
        assert accepted.status_code == 200
        event_name, body = _sse_frame(lines)
        assert event_name == event
        device = next(row for row in body["stats"]["devices"] if row["deviceId"] == device_id)
        assert ("periods" in device) is (event == "stats")
