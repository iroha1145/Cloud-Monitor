"""Pinned v0.62 contracts, independent of the vendored payload generator."""
from __future__ import annotations

import json

import httpx
import pytest

from conftest import NodeHub, load_tm_contract_fixture, requires_node


def load_fixture(name: str, **replacements):
    return load_tm_contract_fixture("v062", name, **replacements)


def assert_fields(actual: dict, expected: dict):
    assert {key: actual.get(key) for key in expected} == expected


def upload(hub, payload):
    response = httpx.post(hub.url + "/api/ingest", headers=hub.headers(), json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return next(device for device in body["stats"]["devices"] if device["deviceId"] == payload["deviceId"])


@requires_node
def test_v062_provider_daily_grants_and_thirdparty_contract(node_hub):
    payload = load_fixture("device-upload.json")
    expected = load_fixture("expected.json")
    record = upload(node_hub, payload)
    providers = {item["provider"]: item for item in record["limits"]["providers"]}
    assert set(providers) == set(expected["providers"])
    for provider in set(expected["providers"]) - {"claude", "thirdparty"}:
        assert_fields(providers[provider]["windows"][0], expected["daily"])
    source = {item["provider"]: item for item in payload["limits"]["providers"]}
    assert providers["claude"]["resetCredits"]["availableCount"] == 2
    assert providers["claude"]["resetCredits"]["grants"] == source["claude"]["resetCredits"]["grants"]
    assert providers["thirdparty"]["adapterId"] == "new-api"
    assert providers["thirdparty"]["usageSummary"] == source["thirdparty"]["usageSummary"]


@requires_node
def test_v062_sessions_components_and_private_text_boundary(node_hub):
    payload = load_fixture("device-upload.json")
    expected = load_fixture("expected.json")
    record = upload(node_hub, payload)
    assert_fields(record["periods"]["today"], expected["today"])
    session = record["periods"]["today"]["sessions"]["codex:s1"]
    assert_fields(session, expected["session"])
    # Full History is retained in the store, not repeated in stats.devices.
    stored = json.loads(node_hub.data_file.read_text())["devices"][payload["deviceId"]]
    assert stored["historyAvailable"] is True
    history = stored["history"]["daily"][0]
    assert_fields(history, {"tokens": 100, "cacheReadTokens": 50, "cacheWriteTokens": 10, "outputTokens": 20, "tokenComponentsAvailable": True})
    assert "PRIVATE SESSION TEXT" not in node_hub.data_file.read_text()
    assert "PRIVATE SESSION TEXT" not in json.dumps(record)


@requires_node
@pytest.mark.parametrize("old_client,new_client", [("micode", "mimo"), ("kilocode", "kilo")])
def test_v062_old_store_alias_is_replaced_not_double_counted(tmp_path, old_client, new_client):
    data_file = tmp_path / "devices.json"
    data_file.write_text(json.dumps(load_fixture("legacy-store.json", **{"$OLD_CLIENT": old_client})))
    hub = NodeHub(data_file)
    try:
        # Opening an old version-1 file must neither fail nor discard its total.
        stats = httpx.get(hub.url + "/api/stats", headers=hub.headers()).json()
        assert stats["periods"]["allTime"]["totalTokens"] == 100
        assert stats["periods"]["allTime"]["clients"] == {new_client: 100}
        payload = {"deviceId": "legacy-device", "updatedAt": load_fixture("device-upload.json")["updatedAt"],
                   "trackedClients": [new_client], **{
                       period: {"totalTokens": 150, "clients": {new_client: 150}}
                       for period in ("today", "month", "allTime")
                   }}
        record = upload(hub, payload)
        for period in ("today", "month", "allTime"):
            assert record["periods"][period]["totalTokens"] == 150
            assert record["periods"][period]["clients"] == {new_client: 150}
    finally:
        hub.stop()
    restarted = NodeHub(data_file)
    try:
        stats = httpx.get(restarted.url + "/api/stats", headers=restarted.headers()).json()
        assert stats["periods"]["allTime"]["totalTokens"] == 150
        assert stats["periods"]["allTime"]["clients"] == {new_client: 150}
    finally:
        restarted.stop()


@requires_node
def test_v062_old_plain_upload_and_runtime_identity_remain_compatible(node_hub):
    expected = load_fixture("expected.json")
    health = httpx.get(node_hub.url + "/api/health").json()
    # The shared core evolves, while the Node adapter remains the same.
    assert_fields(health["hubBuild"], {key: value for key, value in expected["build"].items() if key.startswith("runtime")})
    # Legacy clients do not send new capability or protocol-negotiation headers.
    payload = {"deviceId": "old-agent", "today": {"totalTokens": 9, "clients": {"codex": 9}},
               "allTime": {"totalTokens": 90, "clients": {"codex": 90}}}
    record = upload(node_hub, payload)
    assert record["periods"]["today"]["totalTokens"] == 9
    assert record["periods"]["allTime"]["totalTokens"] == 90
    assert record["periods"]["today"]["capabilities"]["throughput"] is False
