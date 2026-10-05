"""GET /api/v1/tm/provider-status：别名、allowlist、并发预算、SWR/singleflight。

网络全部 Mock，不得访问真实状态页。
"""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from conftest import (
    READ_KEY,
    TM_SECRET,
    API_KEY,
    make_cloud_app,
    requires_node,
    widget_style_payload,
)
from hub.config import Settings
from hub.main import create_app
from hub.tm_provider_status import (
    ALLOWED_FETCH_URLS,
    STATUS_PAGES,
    ProviderStatusService,
    canonical_provider,
    discover_providers,
    fetch_one_provider,
    fetch_provider_statuses,
    parse_rss_payload,
    parse_status_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


def _summary(indicator="none", description="All Systems Operational", components=None, updated="2026-08-23T01:00:00Z"):
    return {
        "page": {"name": "x", "url": "https://status.example", "updated_at": updated},
        "status": {"indicator": indicator, "description": description},
        "components": components or [],
    }


def _openai_ok():
    return _summary(
        components=[
            {"name": "ChatGPT", "status": "major_outage", "updated_at": "2026-08-23T01:00:00Z"},
            {"name": "API", "status": "operational", "updated_at": "2026-08-23T01:02:00Z"},
        ]
    )


def _claude_ok():
    return _summary(
        components=[
            {"name": "claude.ai", "status": "partial_outage"},
            {"name": "Claude API", "status": "operational"},
            {"name": "Claude Code", "status": "operational"},
        ]
    )


def _cursor_ok():
    return _summary(components=[{"name": "API", "status": "operational"}])


class MapTransport(httpx.AsyncBaseTransport):
    """按 allowlist URL 返回预设响应；记录请求，绝不外连。"""

    def __init__(self, mapping: dict, delay: float = 0.0, delays: dict | None = None):
        self.mapping = mapping
        self.delay = delay
        self.delays = delays or {}
        self.urls: list[str] = []
        self.started_at: list[float] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.urls.append(url)
        self.started_at.append(time.monotonic())
        wait = self.delays.get(url, self.delay)
        if wait:
            await asyncio.sleep(wait)
        spec = self.mapping.get(url)
        if spec is None:
            return httpx.Response(404, json={"error": "not allowlisted in mock"})
        if isinstance(spec, Exception):
            raise spec
        if isinstance(spec, httpx.Response):
            return spec
        status, body = spec
        if isinstance(body, (dict, list)):
            return httpx.Response(status, json=body)
        return httpx.Response(status, text=str(body))


def _deepseek_ok():
    return _summary(components=[{"name": "API 服务 (API Service)", "status": "operational"}])


def _kimi_ok():
    return _summary(components=[{"name": "Open API", "status": "operational"}, {"name": "Kimi", "status": "major_outage"}])


def _rss(items, last="Tue, 18 Aug 2026 00:57:02 GMT"):
    rows = []
    for title, status, severity in items:
        rows.append(
            "<item>"
            f"<title>{title}</title>"
            f"<pubDate>{last}</pubDate>"
            "<description><![CDATA["
            f"<h3>Status: {status}</h3><p>Severity: {severity}</p>"
            "]]></description>"
            "</item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel>'
        "<title>SpaceXAI System Status</title>"
        f"<lastBuildDate>{last}</lastBuildDate>"
        + "".join(rows)
        + "</channel></rss>"
    )


def _grok_rss_ok():
    return _rss([
        ("[API (us-east-1.api.x.ai)] grok-4.6 high error rate", "RESOLVED", "available"),
        ("[Grok (Web)] Grok is Temporarily Unavailable", "RESOLVED", "available"),
    ])


def _ok_map():
    return {
        STATUS_PAGES["anthropic"].summary_url: (200, _claude_ok()),
        STATUS_PAGES["openai"].summary_url: (200, _openai_ok()),
        STATUS_PAGES["cursor"].summary_url: (200, _cursor_ok()),
        STATUS_PAGES["deepseek"].summary_url: (200, _deepseek_ok()),
        STATUS_PAGES["kimi"].summary_url: (200, _kimi_ok()),
        STATUS_PAGES["grok"].summary_url: (200, _grok_rss_ok()),
    }


async def _client(mapping, delay=0.0, delays=None, timeout=5.0):
    transport = MapTransport(mapping, delay=delay, delays=delays)
    client = httpx.AsyncClient(transport=transport, timeout=timeout)
    return client, transport


def test_rss_pages_have_a_single_feed_url():
    # fetch_one_provider 对 RSS 页只取一次 summary_url，不回退 status_url；
    # 若以后接入两个地址不同的 RSS 页，需要先恢复回退逻辑。
    rss = [page for page in STATUS_PAGES.values() if page.parser == "rss"]
    assert rss
    assert all(page.summary_url == page.status_url for page in rss)


def test_aliases_map_claude_codex_cursor():
    assert canonical_provider("claude") == "anthropic"
    assert canonical_provider("anthropic") == "anthropic"
    assert canonical_provider("codex") == "openai"
    assert canonical_provider("openai") == "openai"
    assert canonical_provider("cursor") == "cursor"
    assert canonical_provider("deepseek") == "deepseek"
    assert canonical_provider("deepseek-chat") == "deepseek"
    assert canonical_provider("kimi") == "kimi"
    assert canonical_provider("moonshot") == "kimi"
    assert canonical_provider("kimi-k2") == "kimi"
    assert canonical_provider("k3") == "kimi"
    assert canonical_provider("k3-256k") == "kimi"
    assert canonical_provider("K3-256K") == "kimi"
    assert canonical_provider("kimi-k3") == "kimi"
    assert canonical_provider("composer") == "cursor"
    assert canonical_provider("composer-2") == "cursor"
    assert canonical_provider("composer-1.5") == "cursor"
    assert canonical_provider("grok") == "grok"
    assert canonical_provider("xai") == "grok"
    assert canonical_provider("grok-4.6") == "grok"
    assert canonical_provider("cursor-grok-4.6-xhigh-fast") == "grok"
    assert canonical_provider("glm") is None  # 无官方 Statuspage，不出卡
    assert canonical_provider("glm-4.6") is None
    assert canonical_provider("glm-5.3-flash") is None
    assert canonical_provider("muse-spark") is None  # Meta 无状态页，不出卡
    assert canonical_provider("muse-spark-1") is None
    assert canonical_provider("muse spark") is None


def test_discover_from_today_clients_when_limits_off():
    stats = {"periods": {"today": {"clients": {"claude": 10, "codex": 4}}}}
    found = discover_providers(stats)
    assert found["anthropic"] == ["claude"]
    assert found["openai"] == ["codex"]
    assert "cursor" not in found


def test_discover_only_today_usage_not_limits():
    stats = {
        "periods": {"today": {"clients": {}}},
        "limits": {"providers": [{"provider": "claude"}, {"provider": "openai"}]},
    }
    found = discover_providers(stats)
    assert found == {}


def test_discover_from_today_models_and_skip_zero():
    stats = {
        "periods": {
            "today": {
                "clients": {"claude": 0, "deepseek": 8},
                "models": {"kimi-k2": 3, "glm-4.6": 9, "claude-sonnet-4.5": 0},
            }
        }
    }
    found = discover_providers(stats)
    assert found["deepseek"] == ["deepseek"]
    assert found["kimi"] == ["kimi-k2"]
    assert "anthropic" not in found
    assert "glm" not in found


def test_discover_grok_model_also_opens_web_card():
    stats = {
        "periods": {
            "today": {
                "clients": {"cursor": 4},
                "models": {"grok-4.6": 3, "cursor-grok-4.6-xhigh-fast": 9},
            }
        }
    }
    found = discover_providers(stats)
    assert found["cursor"] == ["cursor"]
    assert found["grok"] == ["grok-4.6", "cursor-grok-4.6-xhigh-fast"]
    assert found["grok-web"] == found["grok"]


def test_chatgpt_web_outage_does_not_mark_openai_api_down():
    page = STATUS_PAGES["openai"]
    parsed = parse_status_payload(page, _openai_ok())
    assert parsed["status"] == "operational"
    assert parsed["error_code"] is None


def test_kimi_consumer_outage_does_not_mark_api_down():
    parsed = parse_status_payload(STATUS_PAGES["kimi"], _kimi_ok())
    assert parsed["status"] == "operational"


def test_grok_web_outage_does_not_mark_api_down():
    rss = _rss([
        ("[Grok (Web)] Grok is Temporarily Unavailable", "INVESTIGATING", "outage"),
        ("[Grok (iOS)] Grok is Temporarily Unavailable", "IDENTIFIED", "outage"),
    ])
    api = parse_rss_payload(STATUS_PAGES["grok"], rss)
    web = parse_rss_payload(STATUS_PAGES["grok-web"], rss)
    assert api["status"] == "operational"
    assert web["status"] == "outage"
    assert "Grok (Web)" in (web["description"] or "")


def test_grok_api_outage_does_not_mark_web_down():
    rss = _rss([
        ("[API (us-east-1.api.x.ai)] grok-4.6 high error rate", "INVESTIGATING", "outage"),
        ("[Grok (Web)] 4.3 losing conversation context", "RESOLVED", "available"),
    ])
    api = parse_rss_payload(STATUS_PAGES["grok"], rss)
    web = parse_rss_payload(STATUS_PAGES["grok-web"], rss)
    assert api["status"] == "outage"
    assert web["status"] == "operational"


def test_grok_rss_all_resolved_is_operational():
    parsed = parse_rss_payload(STATUS_PAGES["grok"], _grok_rss_ok())
    assert parsed["status"] == "operational"
    assert parsed["error_code"] is None


def test_rss_body_is_stream_capped_before_parse():
    huge = "a" * (512 * 1024 + 64)
    rss = f"<?xml version='1.0'?><rss><channel><title>{huge}</title></channel></rss>"

    async def run():
        client, _transport = await _client({STATUS_PAGES["grok"].summary_url: (200, rss)})
        try:
            return await fetch_one_provider(client, STATUS_PAGES["grok"], timeout=2.0)
        finally:
            await client.aclose()

    parsed, error = asyncio.run(run())
    assert parsed == {}
    assert error == "payload_too_large"


def test_allowlist_is_fixed_and_has_no_client_url():
    assert STATUS_PAGES["anthropic"].summary_url.endswith("/api/v2/summary.json")
    assert STATUS_PAGES["openai"].status_url.endswith("/api/v2/status.json")
    assert STATUS_PAGES["grok"].summary_url.endswith("/feed.xml")
    assert STATUS_PAGES["grok"].public_url == "https://status.x.ai"
    assert STATUS_PAGES["grok-web"].public_url == "https://status.x.ai/grok-com"
    assert STATUS_PAGES["grok"].parser == "rss"
    for url in ALLOWED_FETCH_URLS:
        host = httpx.URL(url).host
        assert url.startswith("https://")
        assert "/api/v2/" in url or url.endswith("/feed.xml")
        assert host.startswith("status.") or host.endswith(".statuspage.io")


def test_three_status_pages_concurrent_not_serial():
    async def run():
        client, transport = await _client(_ok_map(), delay=0.4)
        started = time.monotonic()
        try:
            providers, errors = await fetch_provider_statuses(
                client,
                {"anthropic": ["claude"], "openai": ["codex"], "cursor": ["cursor"]},
                timeout_seconds=2.5,
                budget_seconds=3.0,
            )
        finally:
            await client.aclose()
        return time.monotonic() - started, providers, errors, transport

    elapsed, providers, errors, transport = asyncio.run(run())
    assert elapsed < 1.5, elapsed  # 并发 0.4s，串行会 ≥1.2s
    assert not errors
    by = {p["provider"]: p for p in providers}
    assert by["anthropic"]["observed_as"] == ["claude"]
    assert by["openai"]["observed_as"] == ["codex"]
    assert by["cursor"]["status"] == "operational"
    hosts = {httpx.URL(u).host for u in transport.urls}
    assert hosts <= {"status.claude.com", "status.openai.com", "status.cursor.com"}


def test_fetch_deepseek_and_kimi_when_observed_today():
    async def run():
        client, transport = await _client(_ok_map())
        try:
            providers, errors = await fetch_provider_statuses(
                client,
                {"deepseek": ["deepseek"], "kimi": ["kimi-k2"]},
                timeout_seconds=2.5,
                budget_seconds=3.0,
            )
        finally:
            await client.aclose()
        return providers, errors, transport

    providers, errors, transport = asyncio.run(run())
    assert not errors
    by = {p["provider"]: p for p in providers}
    assert by["deepseek"]["status"] == "operational"
    assert by["kimi"]["status"] == "operational"
    hosts = {httpx.URL(u).host for u in transport.urls}
    assert hosts <= {"deepseek.statuspage.io", "status.moonshot.cn"}


def test_fetch_grok_api_and_web_when_observed_today():
    async def run():
        client, transport = await _client(_ok_map())
        try:
            providers, errors = await fetch_provider_statuses(
                client,
                {"grok": ["grok-4.6"], "grok-web": ["grok-4.6"]},
                timeout_seconds=2.5,
                budget_seconds=3.0,
            )
        finally:
            await client.aclose()
        return providers, errors, transport

    providers, errors, transport = asyncio.run(run())
    assert not errors
    by = {p["provider"]: p for p in providers}
    assert by["grok"]["status"] == "operational"
    assert by["grok"]["name"] == "SpaceXAI API"
    assert by["grok"]["url"] == "https://status.x.ai"
    assert by["grok-web"]["status"] == "operational"
    assert by["grok-web"]["name"] == "SpaceXAI (Web)"
    assert by["grok-web"]["url"] == "https://status.x.ai/grok-com"
    hosts = {httpx.URL(u).host for u in transport.urls}
    assert hosts <= {"status.x.ai"}


def test_single_timeout_within_budget():
    async def run():
        mapping = _ok_map()
        delays = {
            STATUS_PAGES["openai"].summary_url: 10.0,
            STATUS_PAGES["openai"].status_url: 10.0,
        }
        client, _ = await _client(mapping, delays=delays)
        started = time.monotonic()
        try:
            providers, errors = await fetch_provider_statuses(
                client,
                {"anthropic": ["claude"], "openai": ["codex"], "cursor": ["cursor"]},
                timeout_seconds=0.3,
                budget_seconds=3.0,
            )
        finally:
            await client.aclose()
        return time.monotonic() - started, providers, errors

    elapsed, providers, errors = asyncio.run(run())
    assert elapsed < 3.0, elapsed
    by = {p["provider"]: p for p in providers}
    assert by["anthropic"]["status"] == "operational"
    assert by["openai"]["status"] == "unknown"
    assert by["openai"]["error_code"] == "timeout"
    assert any(e["error_code"] == "timeout" for e in errors)


def test_all_timeouts_within_budget():
    async def run():
        mapping = {url: (200, _summary()) for url in ALLOWED_FETCH_URLS}
        client, _ = await _client(mapping, delay=10.0)
        started = time.monotonic()
        try:
            providers, errors = await fetch_provider_statuses(
                client,
                {"anthropic": ["claude"], "openai": ["codex"], "cursor": ["cursor"]},
                timeout_seconds=0.25,
                budget_seconds=3.0,
            )
        finally:
            await client.aclose()
        return time.monotonic() - started, providers, errors

    elapsed, providers, errors = asyncio.run(run())
    assert elapsed < 3.0, elapsed
    assert len(providers) == 3
    assert all(p["status"] == "unknown" for p in providers)
    assert all(p["error_code"] == "timeout" for p in providers)
    assert len(errors) == 3


def test_stale_while_revalidate_returns_old_value():
    async def run():
        clock = {"t": 1000.0}

        def mono():
            return clock["t"]

        mapping = _ok_map()
        client, transport = await _client(mapping)
        svc = ProviderStatusService(cache_seconds=10, timeout_seconds=2.5, monotonic=mono)
        observed = {"anthropic": ["claude"]}
        try:
            first = await svc.snapshot(client=client, observed=observed)
            clock["t"] = 1011.0
            second = await svc.snapshot(client=client, observed=observed)
            await asyncio.sleep(0.05)
            return first, second, len(transport.urls)
        finally:
            await client.aclose()

    first, second, fetches = asyncio.run(run())
    assert first["providers"][0]["stale"] is False
    assert second["providers"][0]["stale"] is True
    assert second["providers"][0]["status"] == first["providers"][0]["status"]
    assert fetches >= 2


def test_singleflight_coalesces_concurrent_refresh():
    async def run():
        mapping = _ok_map()
        client, transport = await _client(mapping, delay=0.3)
        svc = ProviderStatusService(cache_seconds=300, timeout_seconds=2.5)
        observed = {"anthropic": ["claude"], "openai": ["codex"], "cursor": ["cursor"]}
        try:
            results = await asyncio.gather(
                svc.snapshot(client=client, observed=observed),
                svc.snapshot(client=client, observed=observed),
                svc.snapshot(client=client, observed=observed),
            )
            return transport.urls, results
        finally:
            await client.aclose()

    urls, results = asyncio.run(run())
    assert len(urls) == 3  # 三个状态页各一次，不是 9 次
    assert all(r["providers"] for r in results)


def test_cancelling_one_waiter_does_not_cancel_the_shared_refresh():
    """两个请求等同一次刷新：一个客户端断开（任务被取消）不得连累另一个。"""

    async def run():
        client, transport = await _client(_ok_map(), delay=0.3)
        svc = ProviderStatusService(cache_seconds=300, timeout_seconds=2.5)
        observed = {"anthropic": ["claude"]}
        try:
            first = asyncio.create_task(svc.snapshot(client=client, observed=observed))
            second = asyncio.create_task(svc.snapshot(client=client, observed=observed))
            await asyncio.sleep(0.05)  # 两者都已在等待同一个刷新任务
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            shared_cancelled = svc._inflight.cancelled()
            result = await asyncio.wait_for(second, 2)
            return shared_cancelled, result, transport.urls
        finally:
            await client.aclose()

    shared_cancelled, result, urls = asyncio.run(run())
    assert shared_cancelled is False
    assert [p["provider"] for p in result["providers"]] == ["anthropic"]
    assert result["providers"][0]["stale"] is False
    assert len(urls) == 1  # 仍然只拉了一次


def test_refresh_failure_is_logged_after_every_waiter_left(caplog):
    """唯一的等待者断开后共享刷新才失败：异常仍被读走并记日志，不留给垃圾回收去报。"""

    async def run():
        svc = ProviderStatusService(cache_seconds=300, timeout_seconds=2.5)
        started = asyncio.Event()

        async def failing_fetch(client, observed, key):
            started.set()
            await asyncio.sleep(0.05)
            raise RuntimeError("status pages exploded")

        svc._do_fetch = failing_fetch
        waiter = asyncio.create_task(svc.snapshot(client=None, observed={"anthropic": ["claude"]}))
        await started.wait()
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        await asyncio.wait({svc._inflight})

    with caplog.at_level("WARNING", logger="tm-provider-status"):
        asyncio.run(run())
    assert "后台刷新异常: status pages exploded" in caplog.text


def test_invalid_json_and_non_200_unknown_not_500():
    async def run():
        mapping = {
            STATUS_PAGES["anthropic"].summary_url: (200, "not-json{"),
            STATUS_PAGES["anthropic"].status_url: (500, {"error": "no"}),
            STATUS_PAGES["openai"].summary_url: (503, {"error": "down"}),
            STATUS_PAGES["openai"].status_url: (503, "x"),
        }
        client, _ = await _client(mapping)
        try:
            return await fetch_provider_statuses(
                client,
                {"anthropic": ["claude"], "openai": ["codex"]},
                timeout_seconds=2.5,
            )
        finally:
            await client.aclose()

    providers, errors = asyncio.run(run())
    by = {p["provider"]: p for p in providers}
    assert by["anthropic"]["status"] == "unknown"
    assert by["openai"]["status"] == "unknown"
    assert by["anthropic"]["error_code"] in {"invalid_json", "http_status"}
    assert errors


def _install_transport(cloud, mapping, delay=0.0):
    transport = MapTransport(mapping, delay=delay)
    client = httpx.AsyncClient(transport=transport, timeout=5.0)
    cloud.portal.call(cloud.app.state.http_provider.aclose)
    cloud.app.state.http_provider = client
    cloud.app.state.provider_status = ProviderStatusService(
        cache_seconds=300, timeout_seconds=2.5
    )
    return transport


@requires_node
def test_endpoint_auth_and_secret_isolation(cloud):
    assert cloud.get("/api/v1/tm/provider-status").status_code == 401
    assert cloud.get("/api/v1/tm/provider-status", headers=HEADERS).status_code == 401
    assert cloud.get(
        "/api/v1/tm/provider-status",
        headers={"Authorization": f"Bearer {TM_SECRET}"},
    ).status_code == 401
    assert cloud.get(
        "/api/v1/tm/provider-status",
        headers={"Authorization": f"Bearer {API_KEY}"},
    ).status_code == 401


@requires_node
def test_endpoint_today_usage_not_subscription_only(cloud):
    pa = widget_style_payload("dev-ps")
    pa["limits"] = {"providers": []}
    assert cloud.post("/api/ingest", json=pa, headers=HEADERS).status_code == 200
    put = cloud.put(
        "/api/subscriptions",
        headers=HEADERS,
        json={
            "subscriptions": [
                {
                    "id": "s-cursor",
                    "provider": "cursor",
                    "kind": "subscription",
                    "planName": "Pro",
                    "amountMinor": 2000,
                    "currency": "USD",
                    "interval": "month",
                    "startDate": "2026-01-01",
                }
            ]
        },
    )
    assert put.status_code == 200, put.text[:300]
    transport = _install_transport(cloud, _ok_map())
    resp = cloud.get("/api/v1/tm/provider-status", headers=READ)
    assert resp.status_code == 200, resp.text[:400]
    body = resp.json()
    assert body["schema_version"] == 1
    by = {p["provider"]: p for p in body["providers"]}
    assert "anthropic" in by and "claude" in by["anthropic"]["observed_as"]
    assert "openai" in by and "codex" in by["openai"]["observed_as"]
    assert "cursor" not in by  # 仅订阅、今日无上报 → 不出卡
    assert by["openai"]["status"] == "operational"  # ChatGPT 中断未污染 API
    assert set(transport.urls) == {
        STATUS_PAGES["anthropic"].summary_url,
        STATUS_PAGES["openai"].summary_url,
    }
    features = cloud.get("/api/v1/tm/overview", headers=READ).json()["features"]
    assert features["provider_status"] is True
    assert features["history_daily"] is True


@requires_node
def test_endpoint_reads_only_stats_from_tm_core(cloud, monkeypatch):
    """提供商只按今日用量发现；订阅清单不参与，读不到也不该把响应标成 partial。"""
    pa = widget_style_payload("dev-stats-only")
    assert cloud.post("/api/ingest", json=pa, headers=HEADERS).status_code == 200
    core = cloud.app.state.tm_core
    real_request = core.request
    paths = []

    def request(method, path, **kwargs):
        paths.append((method, path))
        if path == "/api/subscriptions":
            return httpx.Response(503, json={"error": "unavailable"})
        return real_request(method, path, **kwargs)

    monkeypatch.setattr(core, "request", request)
    _install_transport(cloud, _ok_map())
    body = cloud.get("/api/v1/tm/provider-status", headers=READ).json()
    assert paths == [("GET", "/api/stats")]
    assert body["partial"] is False
    assert body["errors"] == []
    assert {p["provider"] for p in body["providers"]} == {"anthropic", "openai"}


@requires_node
def test_ssrf_client_url_is_ignored(cloud):
    pa = widget_style_payload("dev-ssrf")
    cloud.post("/api/ingest", json=pa, headers=HEADERS)
    transport = _install_transport(cloud, _ok_map())
    evil = "http://127.0.0.1:9/steal"
    resp = cloud.get(
        "/api/v1/tm/provider-status",
        headers=READ,
        params={"url": evil},
    )
    assert resp.status_code == 200
    assert evil not in transport.urls
    assert all(u in ALLOWED_FETCH_URLS for u in transport.urls)


@requires_node
def test_overview_not_blocked_by_hanging_status_pages(cloud):
    pa = widget_style_payload("dev-hang")
    cloud.post("/api/ingest", json=pa, headers=HEADERS)
    _install_transport(cloud, _ok_map(), delay=30.0)
    started = time.monotonic()
    resp = cloud.get("/api/v1/tm/overview", headers=READ)
    elapsed = time.monotonic() - started
    assert resp.status_code == 200
    assert elapsed < 5.0, elapsed
    assert "totals" in resp.json()


def test_tm_disabled_404(tmp_path):
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "x.db",
        frontend_dir=tmp_path,
        max_records_per_push=500,
        tm_ingest_secret="",
    )
    app = create_app(settings)
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        resp = client.get("/api/v1/tm/provider-status", headers=READ)
        assert resp.status_code == 404


def test_provider_status_disabled_flag(tmp_path):
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "x.db",
        frontend_dir=tmp_path,
        max_records_per_push=500,
        tm_ingest_secret=TM_SECRET,
        tm_core_url="http://127.0.0.1:9",
        provider_status_enabled=False,
    )
    from fastapi.testclient import TestClient

    with TestClient(create_app(settings)) as client:
        resp = client.get("/api/v1/tm/provider-status", headers=READ)
        assert resp.status_code == 404


@requires_node
def test_tm_core_down_does_not_take_ingest(tmp_path, node_hub):
    cloud = make_cloud_app(tmp_path, "http://127.0.0.1:9", background=False)
    with cloud:
        ingest = cloud.post("/api/ingest", json=widget_style_payload("d"), headers=HEADERS)
        # tm-core 不可达：ingest 暂存并返回 503；provider-status 照常 200，只标 partial
        resp = cloud.get("/api/v1/tm/provider-status", headers=READ)
        assert ingest.status_code == 503
        assert ingest.json()["error"] == "upstream_unavailable"
        assert resp.status_code == 200
        body = resp.json()
        assert body["partial"] is True
        assert body["errors"] == [{"error_code": "stats_unavailable", "source": "tm-core"}]


def test_refuses_non_allowlisted_url():
    from hub.tm_provider_status import _safe_url

    with pytest.raises(ValueError):
        _safe_url("https://evil.example/api/v2/summary.json")
