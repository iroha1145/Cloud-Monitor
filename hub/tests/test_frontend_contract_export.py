"""导出 Overview / history/daily / provider-status 前端契约 fixture（Mock 网络）。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

from conftest import READ_KEY, TM_SECRET, make_cloud_app, requires_node, widget_style_payload
from hub.tm_provider_status import STATUS_PAGES, ProviderStatusService


class _MapTransport(httpx.AsyncBaseTransport):
    def __init__(self, mapping: dict):
        self.mapping = mapping

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        spec = self.mapping.get(str(request.url), (404, {}))
        status, body = spec
        return httpx.Response(status, json=body)


def _ok_map():
    summary = {
        "page": {"updated_at": "2026-08-23T00:00:00Z"},
        "status": {"indicator": "none", "description": "ok"},
        "components": [{"name": "API", "status": "operational"}],
    }
    return {
        STATUS_PAGES["anthropic"].summary_url: (200, summary),
        STATUS_PAGES["openai"].summary_url: (200, summary),
        STATUS_PAGES["cursor"].summary_url: (200, summary),
        STATUS_PAGES["deepseek"].summary_url: (200, summary),
        STATUS_PAGES["kimi"].summary_url: (200, summary),
    }

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}
FIXTURE_DIR = Path(__file__).parent / "fixtures" / "frontend-contract"


@requires_node
def test_export_frontend_contract_fixtures(cloud, tmp_path):
    pa = widget_style_payload("dev-fixture")
    assert cloud.post("/api/ingest", json=pa, headers=HEADERS).status_code == 200
    transport = _MapTransport(_ok_map())
    cloud.app.state.http_async = httpx.AsyncClient(transport=transport, timeout=5.0)
    cloud.app.state.provider_status = ProviderStatusService(cache_seconds=300, timeout_seconds=2.5)

    overview = cloud.get("/api/v1/tm/overview", headers=READ)
    history = cloud.get("/api/v1/tm/history/daily", headers=READ, params={"limit": 5})
    status = cloud.get("/api/v1/tm/provider-status", headers=READ)
    assert overview.status_code == 200
    assert history.status_code == 200
    assert status.status_code == 200

    ov = overview.json()
    hist = history.json()
    st = status.json()
    assert ov["features"]["provider_status"] is True
    assert ov["features"]["history_daily"] is True
    assert "hourly_day" in ov["activity"]
    assert hist["day_basis"] == "device-local"
    assert st["schema_version"] == 1
    assert len(ov["activity"]["daily"]) <= 90

    regenerate = os.environ.get("REGENERATE_FRONTEND_CONTRACT", "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    out = FIXTURE_DIR if regenerate else tmp_path / "frontend-contract"
    out.mkdir(parents=True, exist_ok=True)
    (out / "overview.json").write_text(json.dumps(ov, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "history_daily.json").write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "provider_status.json").write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    assert (out / "overview.json").is_file()
    assert ov["totals"]
    assert hist["items"] is not None
    assert st["schema_version"] == 1
