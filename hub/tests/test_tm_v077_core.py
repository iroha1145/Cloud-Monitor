"""The v0.77 upgrade preserves immediate, restart-safe writes in our launcher."""
from __future__ import annotations

import json

import httpx

from conftest import NodeHub, official_payload, requires_node


@requires_node
def test_acknowledged_upload_survives_abrupt_restart_of_legacy_store(tmp_path, monkeypatch):
    path = tmp_path / "devices.json"
    # Existing releases wrote indented version-1 snapshots. Preserve their
    # content while v0.77 begins writing compact snapshots.
    path.write_text(json.dumps({
        "version": 1,
        "devices": {"existing": {
            "deviceId": "existing", "hostname": "retained-machine",
            "periods": {"allTime": {"totalTokens": 400}},
        }},
    }, indent=2))
    # The custom launcher deliberately keeps immediate persistence, even if an
    # upstream CLI-only batching option is present in its environment.
    monkeypatch.setenv("TOKEN_MONITOR_PERSIST_INTERVAL_MS", "300000")
    node = NodeHub(path)
    try:
        response = httpx.post(node.url + "/api/ingest", headers=node.headers(), json=official_payload({
            "deviceId": "uploaded", "hostname": "new-machine",
            "today": {"totalTokens": 1200}, "allTime": {"totalTokens": 1200},
        }))
        assert response.status_code == 200, response.text
        saved = json.loads(path.read_text())
        assert saved["version"] == 1
        assert saved["devices"]["existing"]["hostname"] == "retained-machine"
        assert saved["devices"]["uploaded"]["periods"]["allTime"]["totalTokens"] == 1200
        node.proc.kill()
        node.proc.wait(timeout=5)
    finally:
        node.stop()

    restarted = NodeHub(path)
    try:
        response = httpx.get(restarted.url + "/api/devices", headers=restarted.headers())
        assert response.status_code == 200
        devices = {row["deviceId"]: row for row in response.json()["devices"]}
        assert devices["existing"]["hostname"] == "retained-machine"
        assert devices["uploaded"]["periods"]["allTime"]["totalTokens"] == 1200
    finally:
        restarted.stop()


@requires_node
def test_same_email_does_not_merge_distinct_cline_credentials(cloud, node_hub):
    from conftest import READ_KEY
    from hub.tm_snapshots import now_z

    stamp = now_z()
    for device_id, account_key, source in [
        ("mac", "cline-key-a", "api"),
        ("linux", "cline-key-b", "api"),
        ("signed-in", "cline-account-a", "oauth"),
        ("same-key-other-device", "cline-key-a", "api"),
    ]:
        payload = {
            "deviceId": device_id, "updatedAt": stamp,
            "limits": {"updatedAt": stamp, "providers": [{
                "provider": "cline", "accountKey": account_key,
                "accountEmail": "same@example.com", "status": "ok",
                "source": source, "updatedAt": stamp,
                "windows": [{"kind": "weekly", "used": 1, "limit": 10}],
            }]},
        }
        response = cloud.post("/api/ingest", headers=node_hub.headers(), json=payload)
        assert response.status_code == 200, response.text
    overview = cloud.get("/api/v1/tm/overview", headers={"Authorization": f"Bearer {READ_KEY}"})
    assert overview.status_code == 200
    providers = overview.json()["limits"]
    rows = [row for row in providers if row["provider"] == "cline"]
    assert {(row["accountKey"], row["source"]) for row in rows} == {
        ("cline-key-a", "api"), ("cline-key-b", "api"), ("cline-account-a", "oauth"),
    }
    assert len(rows) == 3
