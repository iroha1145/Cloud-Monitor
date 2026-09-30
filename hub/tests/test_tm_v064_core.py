"""Official v0.64 wire contracts and old-store compatibility."""
from __future__ import annotations

import json
import subprocess
import sys

import httpx
import pytest

from conftest import HUB_ROOT, READ_KEY, NodeHub, load_tm_contract_fixture, requires_node

READ = {"Authorization": f"Bearer {READ_KEY}"}


def test_v064_vendor_matches_reviewed_pin_and_complete_closure():
    result = subprocess.run(
        [sys.executable, str(HUB_ROOT / "tm-core" / "sync_vendor.py"), "--check"],
        capture_output=True, text=True, check=True,
    )
    assert "v0.64.0 (9ad1ca2f6ec27e497eb38fffe7d9533aec0d3c38)" in result.stdout
    assert "20 source files" in result.stdout


@requires_node
def test_v064_build_identity(node_hub):
    expected = load_tm_contract_fixture("v064", "expected.json")["build"]
    health = httpx.get(node_hub.url + "/api/health").json()
    assert {key: health["hubBuild"][key] for key in expected} == expected


@requires_node
@pytest.mark.parametrize("minimal", [False, True])
def test_v064_upload_survives_gateway_normalization_and_snapshot(cloud, node_hub, minimal):
    payload = load_tm_contract_fixture("v064", "device-upload.json")
    expected = load_tm_contract_fixture("v064", "expected.json")
    headers = node_hub.headers()
    if minimal:
        headers["X-Token-Monitor-Response"] = "minimal"
    response = cloud.post("/api/ingest", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    if minimal:
        assert response.json() == {"ok": True, "deviceId": payload["deviceId"]}
    else:
        assert response.json()["stats"]["periods"]["today"]["totalTokens"] == 1410
    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    today = overview["totals"]["today"]
    assert {key: today[key] for key in expected["today"]} == expected["today"]
    assert today["clients"] == expected["clients"]
    assert today["clientOutputs"] == expected["clientOutputs"]
    assert today["clientModels"]["cursor"] == expected["cursorModels"]
    providers = {item["provider"]: item for item in overview["limits"]}
    assert [[window["kind"], window["usedPercent"]] for window in providers["stepfun"]["windows"]] == expected["stepfunWindows"]
    assert providers["codex"]["planLabel"] == "Pro More"
    assert any(session["client"] == "grok" for session in overview["sessions"])
    session = next(session for session in overview["sessions"] if session["sessionId"] == "codex")
    assert session["contextTokens"] == 1234 and session["turnEnded"] is False
    row = cloud.app.state.db.fetchone("SELECT today_total, models_json FROM tm_snapshot_buckets WHERE device_id=?", (payload["deviceId"],))
    assert row["today_total"] == 1410
    assert json.loads(row["models_json"])["cursor-auto"] == 10


@requires_node
def test_v064_stepfun_token_plan_and_limits_only_updates_keep_usage(cloud, node_hub):
    payload = load_tm_contract_fixture("v064", "device-upload.json")
    assert cloud.post("/api/ingest", headers=node_hub.headers(), json=payload).status_code == 200
    provider = payload["limits"]["providers"][0]
    provider.update(accountLabel="Token Plan", windows=[{"kind": "billing", "label": "Credit", "usedPercent": 25}])
    update = {"deviceId": payload["deviceId"], "updatedAt": payload["updatedAt"], "limitsOnly": True,
              "limits": {"providers": [provider]}}
    response = cloud.post("/api/ingest", headers=node_hub.headers(), json=update)
    assert response.status_code == 200, response.text
    overview = cloud.get("/api/v1/tm/overview", headers=READ).json()
    assert overview["totals"]["today"]["totalTokens"] == 1410
    stepfun = next(item for item in overview["limits"] if item["provider"] == "stepfun")
    window = stepfun["windows"][0]
    assert (window["kind"], window["usedPercent"]) == ("billing", 25)
    assert window.get("remaining") is None
    assert stepfun.get("balanceUsd") is None


@requires_node
def test_v064_new_source_checks_are_retained(cloud, node_hub):
    payload = load_tm_contract_fixture("v064", "device-upload.json")
    assert cloud.post("/api/ingest", headers=node_hub.headers(), json=payload).status_code == 200
    device = cloud.get("/api/devices", headers=node_hub.headers()).json()["devices"][0]
    for client, expected in payload["clientHealth"]["clients"].items():
        assert device["clientHealth"]["clients"][client]["source"]["checks"] == expected["source"]["checks"]


@requires_node
def test_v064_old_cursor_store_merges_only_cursor_models_without_double_counting(tmp_path):
    store = load_tm_contract_fixture("v064", "legacy-store.json")
    expected = load_tm_contract_fixture("v064", "expected.json")
    data_file = tmp_path / "devices.json"
    data_file.write_text(json.dumps(store))
    hub = NodeHub(data_file)
    try:
        for upload in (False, True):
            if upload:
                payload = store["devices"]["legacy-cursor"]
                assert httpx.post(hub.url + "/api/ingest", headers=hub.headers(), json=payload).status_code == 200
            stats = httpx.get(hub.url + "/api/stats", headers=hub.headers()).json()
            for period in stats["periods"].values():
                assert period["totalTokens"] == 41
                assert period["models"] == expected["legacyModels"]
                assert period["clientModels"] == {"cursor": {"cursor-auto": 30}, "claude": {"default": 11}}
                assert period["modelCosts"] == {"cursor-auto": 0.3, "default": 0.11}
                assert "default" not in period["modelCacheReads"]
                assert period["capabilities"]["tokenComponents"] is False
    finally:
        hub.stop()
    restarted = NodeHub(data_file)
    try:
        stats = httpx.get(restarted.url + "/api/stats", headers=restarted.headers()).json()
        assert stats["periods"]["allTime"]["totalTokens"] == 41
        assert stats["periods"]["allTime"]["models"] == expected["legacyModels"]
    finally:
        restarted.stop()
