"""Official v0.70.0 wire contracts, sync routes, and session/throughput fields."""
from __future__ import annotations

import subprocess
import sys

import httpx

from conftest import HUB_ROOT, READ_KEY, requires_node

from hub.tm_snapshots import now_z

READ = {"Authorization": f"Bearer {READ_KEY}"}


def test_v070_vendor_matches_reviewed_pin_and_complete_closure():
    result = subprocess.run(
        [sys.executable, str(HUB_ROOT / "tm-core" / "sync_vendor.py"), "--check"],
        capture_output=True, text=True, check=True,
    )
    assert "v0.70.0 (ac4eeb2c4aea239dd94b67f074c73f69aafc46f8)" in result.stdout
    assert "23 source files" in result.stdout


@requires_node
def test_v070_build_identity(node_hub):
    health = httpx.get(node_hub.url + "/api/health").json()
    expected = {
        "schemaVersion": 1,
        "coreRevision": 80,
        "coreBuildId": "sha256:04f734afadd03540a3db992734808c07803460c4bf4296d912dbf2816102a32a",
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
    assert by_sid["s-sub"]["parentSessionId"] == "s-main"
    assert overview["projects"][0]["unpricedTokens"] == 400
