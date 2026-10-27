"""v0.78–v0.80 kernel changes, checked through the cloud gateway."""
from __future__ import annotations

from conftest import READ_KEY, requires_node

from hub.tm_snapshots import now_z

READ = {"Authorization": f"Bearer {READ_KEY}"}


@requires_node
def test_senpi_spellings_fold_into_one_client(cloud, node_hub):
    stamp = now_z()
    payload = {
        "deviceId": "dev-senpi", "updatedAt": stamp,
        "today": {
            "totalTokens": 500,
            # v0.77 kept the display name as its own hyphenated client.
            "clients": {"senpi": 300, "Senpi (OmO Native)": 200},
        },
    }
    response = cloud.post("/api/ingest", headers=node_hub.headers(), json=payload)
    assert response.status_code == 200, response.text
    today = cloud.get("/api/v1/tm/overview", headers=READ).json()["totals"]["today"]
    assert today["clients"] == {"senpi": 500}


@requires_node
def test_muse_quota_rows_stay_per_device(cloud, node_hub):
    stamp = now_z()
    for device_id, used in (("mac", 3), ("linux", 7)):
        payload = {
            "deviceId": device_id, "updatedAt": stamp,
            "limits": {"updatedAt": stamp, "providers": [{
                "provider": "muse", "status": "ok", "updatedAt": stamp,
                "windows": [{"kind": "weekly", "used": used, "limit": 10}],
            }]},
        }
        response = cloud.post("/api/ingest", headers=node_hub.headers(), json=payload)
        assert response.status_code == 200, response.text
    limits = cloud.get("/api/v1/tm/overview", headers=READ).json()["limits"]
    rows = [row for row in limits if row["provider"] == "muse"]
    # Muse has no portable account id, so two devices are two accounts.
    assert sorted(row["windows"][0]["used"] for row in rows) == [3, 7]


@requires_node
def test_shared_custom_pricing_round_trips_for_kimi_k31_pro(cloud, node_hub):
    # tokscale resolves the bare `k3.1-pro` id to the $0 Kimi Code plan row;
    # devices that enable the shared pricing document price it from here.
    headers = node_hub.headers()
    entry = {"modelId": "k3.1-pro", "inputPerM": 2, "outputPerM": 10,
             "cacheReadPerM": 0.2, "cacheWritePerM": 2}
    put = cloud.put("/api/sync/settings/customPricing", headers=headers,
                    json={"baseRevision": 0, "value": [entry]})
    assert put.status_code == 200, put.text
    assert put.json()["revision"] == 1

    current = cloud.get("/api/sync/settings/customPricing", headers=headers).json()
    assert current["revision"] == 1
    assert current["value"] == [entry]

    stale = cloud.put("/api/sync/settings/customPricing", headers=headers,
                      json={"baseRevision": 0, "value": []})
    assert stale.status_code == 409, stale.text
    invalid = cloud.put("/api/sync/settings/customPricing", headers=headers,
                        json={"baseRevision": 1, "value": [{"modelId": "k3.1-pro", "inputPerM": -1}]})
    assert invalid.status_code == 400, invalid.text
    assert cloud.get("/api/sync/settings/customPricing", headers=headers).json()["value"] == [entry]
