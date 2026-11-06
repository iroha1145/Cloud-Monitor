"""v0.84–v0.87 kernel changes, checked through the cloud gateway."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest

from conftest import READ_KEY, requires_node, widget_style_payload

from hub.tm_snapshots import now_z

READ = {"Authorization": f"Bearer {READ_KEY}"}
UPLOAD = {"X-Token-Monitor-Upload": "1"}


def _later(payload, seconds):
    stamped = copy.deepcopy(payload)
    stamped["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
    return stamped


def _history_days(cloud, headers):
    response = cloud.get("/api/history", headers=headers)
    assert response.status_code == 200, response.text
    return {row["date"]: row["tokens"] for row in response.json()["daily"] if row.get("tokens")}


@requires_node
def test_omitted_history_keeps_the_stored_history_and_null_clears_it(cloud, node_hub):
    # v0.87 producers omit History they already sent within the last 15
    # minutes, whatever Hub they talk to. The gateway must keep forwarding
    # such uploads unchanged so the core preserves its stored History.
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    older = [(today - timedelta(days=n)).isoformat() for n in (2, 1)]
    full = widget_style_payload("v087-history")
    full["history"] = {
        "daily": [{"date": older[0], "tokens": 700, "cost": 1.5},
                  {"date": older[1], "tokens": 900, "cost": 2.0}],
        "monthly": [], "summary": {},
    }
    headers = node_hub.headers()
    assert cloud.post("/api/ingest", json=full, headers=headers).status_code == 200
    assert _history_days(cloud, headers) == {older[0]: 700, older[1]: 900}

    omitted = _later(full, 1)
    del omitted["history"]
    omitted["today"]["totalTokens"] += 1000
    omitted["today"]["clients"]["claude"] += 1000
    response = cloud.post("/api/ingest", json=omitted, headers=headers)
    assert response.status_code == 200, response.text
    assert _history_days(cloud, headers) == {older[0]: 700, older[1]: 900}
    # The live day still moved with the period snapshot.
    stats = cloud.get("/api/stats", headers=headers).json()
    assert stats["periods"]["today"]["totalTokens"] == omitted["today"]["totalTokens"]

    cleared = _later(full, 2)
    cleared["history"] = None
    assert cloud.post("/api/ingest", json=cleared, headers=headers).status_code == 200
    assert _history_days(cloud, headers) == {}


@requires_node
@pytest.mark.parametrize("minimal", [False, True])
def test_gateway_never_offers_upload_deltas(cloud, node_hub, minimal):
    # The vendored core negotiates delta uploads when asked directly...
    payload = widget_style_payload(f"v087-upload-{minimal}")
    response_mode = {"X-Token-Monitor-Response": "minimal"} if minimal else {}
    direct = httpx.post(f"{node_hub.url}/api/ingest", json=payload,
                        headers={**node_hub.headers(), **UPLOAD, **response_mode})
    assert direct.status_code == 200
    assert direct.json()["upload"]["version"] == 1

    # ...but the gateway queues and replays full payloads, so it must not hand
    # out a baseline. Without one, producers never try /api/ingest/delta.
    headers = {**node_hub.headers(), **UPLOAD, **response_mode}
    response = cloud.post("/api/ingest", json=_later(payload, 1), headers=headers)
    assert response.status_code == 200, response.text
    assert "upload" not in response.json()
    assert ("stats" in response.json()) is not minimal

    # A producer that still tries a delta gets a status it recovers from with
    # one full upload (official clients fall back on 400/404/405/409/413);
    # the route does not exist, so the body is never read.
    delta = cloud.post("/api/ingest/delta", headers=headers, json={
        "deviceId": payload["deviceId"], "baseRevision": "x", "patch": [],
    })
    assert delta.status_code == 404


@requires_node
def test_device_kind_passes_the_gateway_and_survives_uploads_without_it(cloud, node_hub):
    headers = node_hub.headers()
    payload = widget_style_payload("v087-kind")
    payload["deviceKind"] = "laptop"
    assert cloud.post("/api/ingest", json=payload, headers=headers).status_code == 200

    older = _later(payload, 1)
    del older["deviceKind"]
    assert cloud.post("/api/ingest", json=older, headers=headers).status_code == 200
    devices = {d["deviceId"]: d for d in cloud.get("/api/stats", headers=headers).json()["devices"]}
    assert devices["v087-kind"]["deviceKind"] == "laptop"

    unknown = _later(payload, 2)
    unknown["deviceKind"] = "toaster"
    assert cloud.post("/api/ingest", json=unknown, headers=headers).status_code == 200
    devices = {d["deviceId"]: d for d in cloud.get("/api/stats", headers=headers).json()["devices"]}
    assert devices["v087-kind"]["deviceKind"] == "computer"


@requires_node
def test_muse_web_quota_is_one_row_while_cli_rows_stay_per_device(cloud, node_hub):
    stamp = now_z()
    later = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
    for device_id, cli_used, web_used, web_at in (("mac", 3, 40, stamp), ("linux", 7, 45, later)):
        payload = {
            "deviceId": device_id, "updatedAt": stamp,
            "limits": {"updatedAt": stamp, "providers": [
                {"provider": "muse", "status": "ok", "updatedAt": stamp,
                 "windows": [{"kind": "weekly", "used": cli_used, "limit": 10}]},
                {"provider": "muse", "source": "web", "status": "ok", "updatedAt": web_at,
                 "windows": [{"kind": "weekly", "used": web_used, "limit": 100}]},
            ]},
        }
        response = cloud.post("/api/ingest", headers=node_hub.headers(), json=payload)
        assert response.status_code == 200, response.text
    rows = [row for row in cloud.get("/api/v1/tm/overview", headers=READ).json()["limits"]
            if row["provider"] == "muse"]
    web = [row["windows"][0]["used"] for row in rows if row.get("source") == "web"]
    cli = sorted(row["windows"][0]["used"] for row in rows if row.get("source") != "web")
    # The web subscription is one account seen from two devices: the newer
    # observation wins. The CLI rows still carry no portable identity.
    assert web == [45]
    assert cli == [3, 7]
