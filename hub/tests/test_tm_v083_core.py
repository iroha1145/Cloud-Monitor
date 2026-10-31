"""v0.81–v0.83 kernel changes, checked through the cloud gateway."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone

import httpx

from conftest import READ_KEY, TM_SECRET, requires_node, widget_style_payload

from hub.tm_snapshots import now_z

READ = {"Authorization": f"Bearer {READ_KEY}"}
SYNC = {"X-Token-Monitor-Secret": TM_SECRET, "X-Token-Monitor-Response": "minimal"}


def _sse_frame(lines):
    event = ""
    for line in lines:
        if line.startswith("event:"):
            event = line.partition(":")[2].strip()
        elif line.startswith("data:"):
            return event, json.loads(line.partition(":")[2])
    raise AssertionError("event stream ended before a frame")


def _later(payload, seconds):
    stamped = copy.deepcopy(payload)
    stamped["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
    return stamped


@requires_node
def test_stream_v4_carries_revisions_and_deltas_through_the_gateway(live_stack):
    # Two devices, so a one-device change is a patch smaller than the full
    # stats frame; for a lone small device the hub rightly sends full stats.
    mac, linux = widget_style_payload("v083-mac"), widget_style_payload("v083-linux")
    for payload in (mac, linux):
        assert httpx.post(f"{live_stack.url}/api/ingest", json=payload, headers=SYNC).status_code == 200
    headers = {"X-Token-Monitor-Secret": TM_SECRET, "X-Token-Monitor-Stream": "4"}
    with httpx.stream("GET", f"{live_stack.url}/api/stats/stream", headers=headers, timeout=5) as response:
        assert response.status_code == 200
        lines = response.iter_lines()
        name, snapshot = _sse_frame(lines)
        # This module's stack has no other subscriber, so the snapshot opens
        # the revision chain.
        assert name == "snapshot" and isinstance(snapshot["revision"], int)

        # A timestamp-only upload renews freshness on the same chain.
        assert httpx.post(f"{live_stack.url}/api/ingest", json=_later(mac, 1), headers=SYNC).status_code == 200
        name, freshness = _sse_frame(lines)
        assert name == "freshness"
        assert (freshness["baseRevision"], freshness["revision"]) == (snapshot["revision"], snapshot["revision"] + 1)

        # A usage change arrives as a patch against that revision.
        changed = _later(mac, 2)
        changed["today"]["totalTokens"] += 1000
        changed["today"]["clients"]["claude"] += 1000
        assert httpx.post(f"{live_stack.url}/api/ingest", json=changed, headers=SYNC).status_code == 200
        name, delta = _sse_frame(lines)
        assert name == "delta"
        assert (delta["baseRevision"], delta["revision"]) == (freshness["revision"], freshness["revision"] + 1)
        assert delta["patch"] and all(op["op"] in {"add", "remove", "replace"} for op in delta["patch"])
        assert "stats" not in delta


@requires_node
def test_session_reasoning_effort_and_model_components_pass_the_gateway(cloud, node_hub):
    stamp = now_z()
    session = {
        "client": "codex", "sessionId": "s-effort", "startedAt": stamp, "lastUsedAt": stamp,
        "totalTokens": 1000, "inputTokens": 300, "outputTokens": 200, "cacheReadTokens": 500,
        "models": {"gpt-5.4": 1000},
        "reasoningEffort": "xhigh",
        "modelTokenComponents": {"gpt-5.4": {
            "totalTokens": 1000, "inputTokens": 300, "cacheReadTokens": 500,
            "cacheWriteTokens": 0, "outputTokens": 200,
        }},
    }
    payload = {
        "deviceId": "dev-effort", "updatedAt": stamp,
        "today": {"totalTokens": 1000, "clients": {"codex": 1000}, "models": {"gpt-5.4": 1000},
                  "sessions": {"codex:s-effort": session}},
    }
    response = cloud.post("/api/ingest", headers=node_hub.headers(), json=payload)
    assert response.status_code == 200, response.text

    # The gateway validator passes the new session fields to the core untouched.
    stats = cloud.get("/api/stats", headers=node_hub.headers()).json()
    stored = next(iter(stats["periods"]["today"]["sessions"].values()))
    assert stored["reasoningEffort"] == "xhigh"
    assert stored["modelTokenComponents"]["gpt-5.4"]["cacheReadTokens"] == 500

    # The overview carries the effort the session details show; per-model
    # components have no reader there yet and stay in the core's stats.
    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    by_sid = {s["sessionId"]: s for s in overview["sessions"]}
    assert by_sid["s-effort"]["reasoningEffort"] == "xhigh"
    assert "modelTokenComponents" not in by_sid["s-effort"]
