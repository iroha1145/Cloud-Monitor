"""A failed upload must recover through the worker, persisted history and overview."""
import time

from conftest import READ_KEY, TM_SECRET, make_cloud_app, requires_node, widget_style_payload
from hub.db import Database
from hub.tm_proxy import UpstreamUnavailable


@requires_node
def test_background_delivery_reaches_persisted_history_and_refreshed_overview(node_hub, tmp_path, monkeypatch):
    monkeypatch.setattr("hub.tm_forwarding.RETRY_BASE_SECONDS", .2)
    client = make_cloud_app(tmp_path, node_hub.url, background=True)
    blocked = {"value": True}
    with client:
        core = client.app.state.tm_core
        real_request = core.request

        def request(method, path, **kwargs):
            if method == "POST" and path == "/api/ingest" and blocked["value"]:
                raise UpstreamUnavailable("injected delivery outage")
            return real_request(method, path, **kwargs)

        monkeypatch.setattr(core, "request", request)
        payload = widget_style_payload("background-recovery-proof")
        expected = payload["today"]["totalTokens"]
        response = client.post("/api/ingest", json=payload,
                               headers={"X-Token-Monitor-Secret": TM_SECRET})
        assert response.status_code == 503
        read_headers = {"Authorization": f"Bearer {READ_KEY}"}
        queued = client.get("/api/v1/tm/overview", headers=read_headers).json()
        assert queued["forwarding_outbox"] == 1
        assert queued["pending_outbox"] == 1
        db = client.app.state.db
        database_path = db.path
        assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets")["n"] == 0

        blocked["value"] = False
        client.app.state.tm_background.wake()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            saved = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE device_id=?",
                                (payload["deviceId"],))
            if saved and saved["state"] == "done":
                break
            time.sleep(.02)
        else:
            raise AssertionError("background delivery did not persist its acknowledgement")

        refreshed = client.get("/api/v1/tm/overview", headers=read_headers).json()
        assert refreshed["forwarding_outbox"] == 0
        assert refreshed["pending_outbox"] == 0
        assert refreshed["snapshot_degraded"] is False
        device = next(row for row in refreshed["devices"] if row["deviceId"] == payload["deviceId"])
        assert device["today"]["totalTokens"] == expected
        history = client.get("/api/v1/tm/history/daily", headers=read_headers).json()
        assert any(row["tokens"] == expected for row in history["items"])
        assert client.get("/api/v1/health/ready").status_code == 200

    reopened = Database(database_path)
    try:
        row = reopened.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id=?",
                                (payload["deviceId"],))
        assert row["today_total"] == expected
        acknowledged = reopened.fetchone("SELECT state, normalized_json, forward_payload_json "
                                         "FROM tm_ingest_outbox WHERE device_id=?", (payload["deviceId"],))
        assert acknowledged["state"] == "done"
        assert acknowledged["normalized_json"]
        assert acknowledged["forward_payload_json"] is None
    finally:
        reopened.close()
