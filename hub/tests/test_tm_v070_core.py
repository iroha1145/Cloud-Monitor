"""Wire contracts, sync routes and session/throughput fields introduced in v0.70.0,
checked against the current vendored pin (v0.74.0)."""
from __future__ import annotations

import copy
import subprocess
import sys

import httpx
import pytest

from conftest import HUB_ROOT, READ_KEY, requires_node

from hub.tm_snapshots import now_z
from hub.tm_validate import PayloadValidationError, validate_ingest_payload

READ = {"Authorization": f"Bearer {READ_KEY}"}


def test_vendor_matches_reviewed_pin_and_complete_closure():
    result = subprocess.run(
        [sys.executable, str(HUB_ROOT / "tm-core" / "sync_vendor.py"), "--check"],
        capture_output=True, text=True, check=True,
    )
    assert "v0.74.0 (cbed5915e294abb4a210f7ebb385e9415f706821)" in result.stdout
    assert "24 source files" in result.stdout


@requires_node
def test_vendored_hub_build_identity(node_hub):
    health = httpx.get(node_hub.url + "/api/health").json()
    expected = {
        "schemaVersion": 1,
        "coreRevision": 88,
        "coreBuildId": "sha256:43e2cae75b5d4023a92e01ad2a686cf7fcece84793984a779f4e0802300f7744",
        "runtime": "node-hub",
        "runtimeRevision": 5,
        "runtimeBuildId": "sha256:d825a515df8f90735f15682eaae40d039b266b21a0e282667d6f6472987977e8",
    }
    assert {key: health["hubBuild"][key] for key in expected} == expected


@requires_node
def test_v070_new_clients_session_fields_and_sync_routes(cloud, node_hub):
    headers = node_hub.headers()
    content_resp = cloud.get("/api/sync/content", headers=headers)
    assert content_resp.status_code == 200
    content = content_resp.json()
    assert content["sharedSettings"] is True
    assert content["sessionTitles"]["enabled"] is False

    alias_get = cloud.get("/api/sync/settings/modelAliases", headers=headers)
    assert alias_get.status_code == 200
    assert alias_get.json()["revision"] == 0

    alias_put = cloud.put(
        "/api/sync/settings/modelAliases",
        headers=headers,
        json={
            "baseRevision": 0,
            "value": {
                "modelAliases": {"sonnet-latest": "claude-sonnet-4-5"},
                "modelAliasGrouping": "duplicates",
            },
        },
    )
    assert alias_put.status_code == 200, alias_put.text
    assert alias_put.json()["revision"] == 1

    stamp = now_z()
    payload = {
        "deviceId": "dev-v070",
        "hostname": "MacStudio",
        "updatedAt": stamp,
        "trackedClients": ["catpaw", "fx", "mcode", "codex"],
        "today": {
            "totalTokens": 3500,
            "costUsd": 0.42,
            "outputTokens": 700,
            "cacheReadTokens": 2000,
            "cacheWriteTokens": 300,
            "unclassifiedTokens": 500,
            "unpricedTokens": 400,
            "timedTokens": 2500,
            "timedOutputTokens": 600,
            "timedDurationMs": 12000,
            "clients": {"catpaw": 1000, "fx": 800, "mcode": 700, "codex": 1000},
            "clientUnpricedTokens": {"catpaw": 400},
            "models": {"MiniMax-M2.7": 700, "gpt-5.4": 1000, "fx-1": 800, "catpaw-1": 1000},
            "modelUnpricedTokens": {"catpaw-1": 400},
            "clientModels": {
                "mcode": {"MiniMax-M2.7": 700},
                "codex": {"gpt-5.4": 1000},
                "fx": {"fx-1": 800},
                "catpaw": {"catpaw-1": 1000},
            },
            "clientModelUnpricedTokens": {"catpaw": {"catpaw-1": 400}},
            "modelThroughput": {
                "gpt-5.4": {
                    "timedTokens": 2500,
                    "timedOutputTokens": 600,
                    "timedDurationMs": 12000,
                }
            },
            "sessions": {
                "codex:s-main": {
                    "client": "codex",
                    "sessionId": "s-main",
                    "tokens": 1000,
                    "costUsd": 0.2,
                    "startedAt": stamp,
                    "lastUsedAt": stamp,
                    "turnEnded": False,
                    "waitingForInput": True,
                    "liveActivity": {
                        "state": "waiting",
                        "observedAt": stamp,
                    },
                    "promptCache": {
                        "observedAt": stamp,
                        "ttlSeconds": 300,
                    },
                    "usageSource": "codex-dots-local",
                    "usageCoverage": "observed-only",
                },
                "codex:s-sub": {
                    "client": "codex",
                    "sessionId": "s-sub",
                    "parentSessionId": "s-main",
                    "tokens": 200,
                    "costUsd": 0.05,
                    "startedAt": stamp,
                    "lastUsedAt": stamp,
                    "turnEnded": True,
                },
            },
        },
        "allTime": {
            "totalTokens": 3500,
            "costUsd": 0.42,
            "projects": {
                "cloud-monitor": {
                    "label": "cloud-monitor",
                    "tokens": 3500,
                    "costUsd": 0.42,
                    "unpricedTokens": 400,
                    "clients": {"codex": 1000, "catpaw": 1000},
                }
            },
        },
    }
    ingest = cloud.post("/api/ingest", headers=headers, json=payload)
    assert ingest.status_code == 200, ingest.text

    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    today = overview["totals"]["today"]
    assert today["clients"] == {"catpaw": 1000, "fx": 800, "mcode": 700, "codex": 1000}
    assert today["unpricedTokens"] == 400
    assert today["modelThroughput"]["gpt-5.4"]["timedOutputTokens"] == 600
    by_sid = {s["sessionId"]: s for s in overview["sessions"]}
    assert by_sid["s-main"]["waitingForInput"] is True
    assert by_sid["s-main"]["liveActivity"]["state"] == "waiting"
    assert by_sid["s-main"]["usageSource"] == "codex-dots-local"
    assert by_sid["s-main"]["usageCoverage"] == "observed-only"
    assert by_sid["s-sub"]["parentSessionId"] == "s-main"
    assert overview["projects"][0]["unpricedTokens"] == 400


@requires_node
def test_v070_session_field_validation_and_sync_body_limits(cloud, node_hub):
    headers = node_hub.headers()
    stamp = now_z()
    bad_sessions = [
        {"promptCache": {"observedAt": stamp, "ttlSeconds": True}},
        {"promptCache": {"observedAt": stamp, "ttlSeconds": -1}},
        {"liveActivity": {"state": "running", "observedAt": 12345}},
        {"liveActivity": {"state": "running", "observedAt": "2099-01-01T00:00:00Z"}},
    ]
    for extra in bad_sessions:
        resp = cloud.post(
            "/api/ingest",
            headers=headers,
            json={
                "deviceId": "dev-bad-v070",
                "updatedAt": stamp,
                "today": {
                    "totalTokens": 10,
                    "sessions": {
                        "codex:s1": {
                            "client": "codex",
                            "sessionId": "s1",
                            "tokens": 10,
                            **extra,
                        }
                    },
                },
            },
        )
        assert resp.status_code == 400, (extra, resp.text)

    not_found = cloud.put(
        "/api/sync/settings/zzz",
        headers=headers,
        json={"baseRevision": 0, "value": {}},
    )
    assert not_found.status_code == 404
    assert not_found.json() == {"error": "not_found"}

    oversized = b'{"x":"' + (b"a" * (1024 * 1024 + 64)) + b'"}'
    for path in (
        "/api/sync/content",
        "/api/sync/settings/modelAliases",
        "/api/sync/settings/zzz",
        "/api/sync/titles/dev-1",
    ):
        resp = cloud.put(
            path,
            headers={**headers, "Content-Type": "application/json"},
            content=oversized,
        )
        assert resp.status_code == 413, (path, resp.status_code, resp.text)


def _v070_payload(stamp: str) -> dict:
    return {
        "deviceId": "dev-v070",
        "updatedAt": stamp,
        "today": {
            "totalTokens": 10,
            "sessions": {
                "codex:s": {
                    "client": "codex", "sessionId": "s", "totalTokens": 10, "lastUsedAt": stamp,
                    "liveActivity": {"state": "running", "observedAt": stamp},
                    "promptCache": {"observedAt": stamp, "ttlSeconds": 300},
                }
            },
        },
    }


def _session(p: dict) -> dict:
    return p["today"]["sessions"]["codex:s"]


V070_BAD_FIELDS = {
    "title_generation_zero": lambda p: p.__setitem__("sessionTitleSyncGeneration", 0),
    "title_generation_bool": lambda p: p.__setitem__("sessionTitleSyncGeneration", True),
    "title_generation_text": lambda p: p.__setitem__("sessionTitleSyncGeneration", "1"),
    "nested_unpriced_negative": lambda p: p["today"].__setitem__("clientModelUnpricedTokens", {"a": {"m": -5}}),
    "nested_unpriced_bool": lambda p: p["today"].__setitem__("clientModelUnpricedTokens", {"a": {"m": True}}),
    "nested_cost_negative": lambda p: p["today"].__setitem__("clientModelCosts", {"a": {"m": -1.5}}),
    "cache_ttl_text": lambda p: _session(p)["promptCache"].__setitem__("ttlSeconds", "300"),
    "cache_ttl_fraction": lambda p: _session(p)["promptCache"].__setitem__("ttlSeconds", 300.5),
    "live_observed_number": lambda p: _session(p)["liveActivity"].__setitem__("observedAt", 12345),
    "live_observed_future": lambda p: _session(p)["liveActivity"].__setitem__("observedAt", "2099-01-01T00:00:00Z"),
    "throughput_list": lambda p: p["today"].__setitem__("modelThroughput", []),
    "session_activity_text": lambda p: p["today"].__setitem__("sessionActivity", "x"),
}


def test_v070_valid_payload_is_accepted():
    validate_ingest_payload(_v070_payload(now_z()))


@pytest.mark.parametrize("mutate", V070_BAD_FIELDS.values(), ids=V070_BAD_FIELDS.keys())
def test_v070_malformed_fields_are_rejected(mutate):
    payload = copy.deepcopy(_v070_payload(now_z()))
    mutate(payload)
    with pytest.raises(PayloadValidationError):
        validate_ingest_payload(payload)
