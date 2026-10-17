"""Isolated, real FastAPI + official Node hub fixture serving production assets."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import sys
import tempfile
import uvicorn
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

HUB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HUB / "tests"))
sys.path.insert(0, str(HUB / "backend"))
from conftest import NodeHub, official_payload, widget_style_payload, TM_SECRET, API_KEY, READ_KEY
from hub.config import Settings
from hub.main import create_app
from hub.auth import require_access_token
from hub.tm_proxy import UpstreamUnavailable
from hub import tm_forwarding


def session_detail_fixture():
    """Synthetic records passed through the actual upstream normalization path.

    The browser still posts these through /api/ingest. No fixture endpoint writes
    directly into either database or supplies a replacement overview response.
    """
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stamp = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    started_at = stamp(now - timedelta(minutes=10))
    last_used_at = stamp(now - timedelta(minutes=1))
    first_model, second_model = "detail-model-primary", "detail-model-secondary"

    def period(multiplier):
        return {
            "totalTokens": 16000 * multiplier, "costUsd": .42 * multiplier,
            "outputTokens": 2400 * multiplier, "cacheReadTokens": 9000 * multiplier,
            "cacheWriteTokens": 1000 * multiplier,
            "clients": {"codex": 16000 * multiplier}, "clientCosts": {"codex": .42 * multiplier},
            "clientOutputs": {"codex": 2400 * multiplier},
            "clientCacheReads": {"codex": 9000 * multiplier},
            "clientCacheWrites": {"codex": 1000 * multiplier},
            "models": {first_model: 10000 * multiplier, second_model: 6000 * multiplier},
            "modelCosts": {first_model: .30 * multiplier, second_model: .12 * multiplier},
            "modelOutputs": {first_model: 1500 * multiplier, second_model: 900 * multiplier},
            "modelCacheReads": {first_model: 5625 * multiplier, second_model: 3375 * multiplier},
            "modelCacheWrites": {first_model: 625 * multiplier, second_model: 375 * multiplier},
            "clientModels": {"codex": {first_model: 10000 * multiplier, second_model: 6000 * multiplier}},
            "clientModelCosts": {"codex": {first_model: .30 * multiplier, second_model: .12 * multiplier}},
            "timedTokens": 16000 * multiplier, "timedOutputTokens": 2400 * multiplier,
            "timedDurationMs": 60000 * multiplier,
            "modelThroughput": {
                first_model: {"timedTokens": 10000 * multiplier, "timedOutputTokens": 1500 * multiplier, "timedDurationMs": 37500 * multiplier},
                second_model: {"timedTokens": 6000 * multiplier, "timedOutputTokens": 900 * multiplier, "timedDurationMs": 22500 * multiplier},
            },
            "sessions": {"codex:detailed-mixed": {
                "client": "codex", "sessionId": "detailed-mixed", "projectId": "detail-fixture-project",
                "projectLabel": "detail-fixture-project", "totalTokens": 16000 * multiplier,
                "inputTokens": 3600 * multiplier, "outputTokens": 2400 * multiplier,
                "cacheReadTokens": 9000 * multiplier, "cacheWriteTokens": 1000 * multiplier,
                "reasoningTokens": 800 * multiplier, "messageCount": 12 * multiplier,
                "costUsd": .42 * multiplier,
                "models": {first_model: 10000 * multiplier, second_model: 6000 * multiplier},
                "modelCosts": {first_model: .30 * multiplier, second_model: .12 * multiplier},
                "providers": {"openai": 16000 * multiplier},
                "nativeSessionId": "11223344-1234-4abc-8abc-1234567890ab", "t3ThreadId": "fixture-thread",
                "contextTokens": 208000, "contextWindow": 200000,
                "timedOutputTokens": 2400 * multiplier, "timedDurationMs": 60000 * multiplier,
                "startedAt": started_at, "lastUsedAt": last_used_at, "turnEnded": True,
                "parentSessionId": "fixture-parent", "parentClient": "codex",
            }},
        }

    full = widget_style_payload("session-details-real-device", tz="UTC")
    full.update(hostname="details-fixture", projectsEnabled=True,
                today=period(1), month=period(3), allTime=period(3))
    # Unlike the detailed record, this legacy source genuinely omits every
    # output/cache/reasoning/count/cost observation. Upstream inserts zero values;
    # the compiled webpage must keep those values unconfirmed after synchronization.
    legacy = widget_style_payload("session-details-legacy-device", tz="UTC")
    legacy.update(hostname="legacy-details-fixture", projectsEnabled=True)
    legacy_period = {
        "totalTokens": 1000, "clients": {"codex": 1000}, "models": {first_model: 1000},
        "clientModels": {"codex": {first_model: 1000}},
        "sessions": {"codex:legacy-missing": {
            "client": "codex", "sessionId": "legacy-missing", "totalTokens": 1000,
            "inputTokens": 1000, "models": {first_model: 1000},
            "projectId": "legacy-fixture-project", "projectLabel": "legacy-fixture-project",
            "startedAt": started_at, "lastUsedAt": last_used_at, "contextWindow": 200000,
        }},
    }
    legacy.update(today=legacy_period, month=legacy_period, allTime=legacy_period)
    return {"payloads": [official_payload(full), official_payload(legacy)],
            "expected": {"startedAt": started_at, "lastUsedAt": last_used_at}}


with tempfile.TemporaryDirectory(prefix="cm-dashboard-e2e-") as directory:
    root = Path(directory)
    node = NodeHub(root / "node.json")
    try:
        settings = Settings(api_key=API_KEY, access_token=READ_KEY, database_path=root / "hub.sqlite3", frontend_dir=HUB / "frontend", max_records_per_push=500, tm_ingest_secret=TM_SECRET, tm_core_url=node.url, tm_background_enabled=False, provider_status_enabled=False, overview_cache_seconds=0, serve_demo_route=True)
        app = create_app(settings)
        with TestClient(app) as client:
            response = client.post("/api/ingest", headers={"X-Token-Monitor-Secret": TM_SECRET}, json=widget_style_payload("responsive-real-device"))
            assert response.status_code == 200, response.text
        # The control route and short retry interval exist only in this isolated
        # test fixture. Production code exposes neither a fault switch nor a
        # writable diagnostics endpoint.
        from dataclasses import replace
        hosted = create_app(replace(settings, tm_background_enabled=True))
        blocked = {"value": False}
        original_request = hosted.state.tm_core.request
        tm_forwarding.RETRY_BASE_SECONDS = .2

        def controlled_request(method, path, **kwargs):
            payload = kwargs.get("json_body") or {}
            if (method == "POST" and path == "/api/ingest"
                    and payload.get("deviceId") == "recovery-real-device" and blocked["value"]):
                raise UpstreamUnavailable("test fixture delivery outage")
            return original_request(method, path, **kwargs)

        hosted.state.tm_core.request = controlled_request

        @hosted.get("/__test/session-details")
        def session_details(request: Request):
            require_access_token(request, settings)
            return session_detail_fixture()

        @hosted.post("/__test/forwarding/{operation}")
        def control_forwarding(operation: str, request: Request):
            require_access_token(request, settings)
            if operation not in {"block", "resume"}:
                raise HTTPException(400, "unknown fixture operation")
            blocked["value"] = operation == "block"
            hosted.state.tm_background.wake()
            return {"blocked": blocked["value"]}

        uvicorn.run(hosted, host="127.0.0.1", port=18888, log_level="warning")
    finally:
        node.stop()
