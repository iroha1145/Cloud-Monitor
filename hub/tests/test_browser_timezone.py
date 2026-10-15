"""Viewer-local activity, tenant/cache boundaries, and device-local archives."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import READ_KEY, TM_SECRET, make_settings, seed_bucket
from hub.config import TenantConfig
from hub.db import Database
from hub.tm_outbox import ensure_schema as ensure_outbox
from hub.tm_overview import OverviewCache, activity_report, build_tm_overview_router
from hub.tm_proxy import UpstreamUnavailable
from hub.tm_snapshots import ensure_schema as ensure_snapshots

READ = {"Authorization": f"Bearer {READ_KEY}"}
ALICE_READ = "alice-read-0123456789abcdef0000000"
NOW = datetime(2026, 10, 15, 2, tzinfo=timezone.utc)


class Core:
    def __init__(self):
        self.calls = 0
        self.failed = False

    def request(self, _method, path):
        if self.failed:
            raise UpstreamUnavailable("test outage")
        if path == "/api/stats":
            self.calls += 1
            return httpx.Response(200, json={"devices": [], "totals": {"today": {"totalTokens": 42}}})
        return httpx.Response(200, json={"daily": [], "devices": []})


@pytest.fixture
def dashboard(tmp_path, monkeypatch):
    from hub import tm_overview

    original_now = tm_overview._now_for_dashboard
    monkeypatch.setattr(tm_overview, "_now_for_dashboard", lambda zone, now=None: original_now(zone, now or NOW))
    settings = make_settings(
        tmp_path, tm_ingest_secret=TM_SECRET, dashboard_time_zone="UTC",
        tenants={"alice": TenantConfig("alice", "alice-sync-0123456789abcdef0000000", ALICE_READ)},
    )
    databases = [Database(tmp_path / f"{name}.sqlite3") for name in ("root", "alice")]
    for db, total in zip(databases, (100, 900)):
        ensure_snapshots(db)
        ensure_outbox(db)
        seed_bucket(db, "same-device", "2026-10-14", "2026-10-14T23:00:00Z", 0, tz="UTC")
        seed_bucket(db, "same-device", "2026-10-14", "2026-10-14T23:05:00Z", total, tz="UTC")
    core = Core()
    app = FastAPI()
    router, cache = build_tm_overview_router(settings, databases[0])
    app.include_router(router)
    app.state.tm_core = core
    app.state.tm_tenants = {"alice": SimpleNamespace(
        db=databases[1], core=Core(), overview_cache=OverviewCache(), provider_status=None,
    )}
    with TestClient(app) as client:
        yield app, client, cache, core
    for db in databases:
        db.close()


def view(client, zone=None, *, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else dict(READ)
    if zone is not None:
        headers["X-CM-Time-Zone"] = zone
    response = client.get("/api/v1/tm/overview", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_viewer_days_hours_and_cache_do_not_cross_time_zones_or_tenants(dashboard):
    _app, client, _cache, core = dashboard
    tokyo = view(client, "Asia/Tokyo")
    la = view(client, "America/Los_Angeles")
    assert tokyo["dashboard_period"]["today"]["key"] == "2026-10-15"
    assert la["dashboard_period"]["today"]["key"] == "2026-10-14"
    assert tokyo["activity"]["hourly"][8]["total"] == 100
    assert la["activity"]["hourly"][16]["total"] == 100
    assert tokyo["dashboard_time_zone"] == "Asia/Tokyo"
    assert la["dashboard_time_zone"] == "America/Los_Angeles"
    assert tokyo["trend"] == la["trend"]
    assert tokyo["totals"] == la["totals"]
    assert view(client, "Asia/Tokyo") == tokyo
    assert view(client, "America/Los_Angeles") == la
    assert core.calls == 2
    alice = view(client, "America/Los_Angeles", token=ALICE_READ)
    assert alice["activity"]["hourly"][16]["total"] == 900
    assert view(client, "America/Los_Angeles")["activity"]["hourly"][16]["total"] == 100
    assert view(client)["dashboard_time_zone"] == "UTC"


def test_archive_metadata_follows_viewer_without_relabelling_device_days(dashboard):
    _app, client, _cache, _core = dashboard
    pages = [client.get("/api/v1/tm/history/daily", headers={**READ, "X-CM-Time-Zone": zone}).json()
             for zone in ("Asia/Tokyo", "America/Los_Angeles")]
    assert [page["dashboard_time_zone"] for page in pages] == ["Asia/Tokyo", "America/Los_Angeles"]
    assert pages[0]["items"] == pages[1]["items"]
    assert pages[0]["items"][0]["day"] == "2026-10-14"
    assert pages[0]["next_cursor"] == pages[1]["next_cursor"]
    assert all(page["day_basis"] == "device-local" for page in pages)


@pytest.mark.parametrize("zone", ["", "Mars/Olympus", "../etc/passwd", "x" * 129])
@pytest.mark.parametrize("path", ["/api/v1/tm/overview", "/api/v1/tm/history/daily"])
def test_invalid_browser_zone_is_rejected(dashboard, zone, path):
    _app, client, _cache, _core = dashboard
    response = client.get(path, headers={**READ, "X-CM-Time-Zone": zone})
    assert response.status_code == 400
    assert "IANA" in response.json()["detail"]


def test_concurrent_refreshes_and_stale_fallback_stay_in_their_own_zone(dashboard):
    app, client, cache, core = dashboard

    async def refresh():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as session:
            zones = ["Asia/Tokyo", "America/Los_Angeles", "Asia/Tokyo"]
            responses = await asyncio.gather(*(
                session.get("/api/v1/tm/overview", headers={**READ, "X-CM-Time-Zone": zone})
                for zone in zones
            ))
            assert [response.json()["dashboard_time_zone"] for response in responses] == zones
            assert all(response.status_code == 200 for response in responses)

    asyncio.run(refresh())
    assert core.calls == 2
    cache.invalidate()
    core.failed = True
    for zone in ("Asia/Tokyo", "America/Los_Angeles"):
        stale = view(client, zone)
        assert stale["dashboard_time_zone"] == zone
        assert stale["partial_errors"][-1]["code"] == "overview_stale"
    # An outage must not borrow another zone's available stale response.
    response = client.get("/api/v1/tm/overview", headers={**READ, "X-CM-Time-Zone": "Europe/London"})
    assert response.status_code == 502


def test_invalidation_reaches_every_variant_and_cannot_publish_an_old_build_as_fresh():
    cache = OverviewCache()
    variants = [cache, cache.for_time_zone("Asia/Tokyo"), cache.for_time_zone("America/Los_Angeles")]
    generations = [variant.generation for variant in variants]
    for variant in variants:
        variant.put({"old": True})
    cache.invalidate()
    for variant, generation in zip(variants, generations):
        assert variant.get() is None
        variant.put({"late": True}, generation=generation)
        assert variant.get() is None
        assert variant.get(allow_stale=True) == {"late": True}
    # LRU variants are bounded; frequently used zones retain their cache.
    for index in range(20):
        cache.for_time_zone("Asia/Tokyo")
        cache.for_time_zone(f"test-zone-{index}")
    assert len(cache._time_zones) == 8
    assert cache.for_time_zone("Asia/Tokyo") is variants[1]


@pytest.mark.parametrize("zone,day,hour", [
    ("Etc/GMT+12", "2026-10-14", 22),
    ("Pacific/Kiritimati", "2026-10-16", 0),
])
def test_extreme_device_and_viewer_dates_keep_the_same_delta(dashboard, zone, day, hour):
    app, _client, _cache, _core = dashboard
    db = app.state.tm_tenants["alice"].db
    seed_bucket(db, "extreme", "2026-10-16", "2026-10-15T10:00:00Z", 0, tz="Pacific/Kiritimati")
    seed_bucket(db, "extreme", "2026-10-16", "2026-10-15T10:05:00Z", 70, tz="Pacific/Kiritimati")
    report = activity_report(db, zone, now=datetime(2026, 10, 15, 10, 10, tzinfo=timezone.utc))
    assert report["hourly_day"] == day
    assert report["hourly"][hour]["total"] == 70


def test_padded_query_does_not_overwrite_older_device_day_archives(dashboard):
    app, _client, _cache, _core = dashboard
    db = app.state.tm_tenants["alice"].db
    seed_bucket(db, "archived", "2026-10-07", "2026-10-07T00:00:00Z", 300, tz="UTC")
    # Device Oct 8 is viewer Oct 7, outside the fine window starting Oct 8.
    seed_bucket(db, "ahead", "2026-10-08", "2026-10-07T10:00:00Z", 50, tz="Pacific/Kiritimati")
    seed_bucket(db, "ahead", "2026-10-08", "2026-10-07T11:00:00Z", 100, tz="Pacific/Kiritimati")
    report = activity_report(db, "UTC", now=NOW)
    daily = {row["day"]: row["total"] for row in report["daily"]}
    assert daily["2026-10-07"] == 300


@pytest.mark.parametrize("now,expected_hours", [
    (datetime(2026, 3, 8, 12, tzinfo=timezone.utc), 23),
    (datetime(2026, 11, 1, 12, tzinfo=timezone.utc), 25),
])
def test_browser_day_boundaries_follow_daylight_saving(now, expected_hours):
    from hub.tm_overview import _dashboard_period
    from zoneinfo import ZoneInfo

    period = _dashboard_period("America/Los_Angeles", now=now)
    start = datetime.fromisoformat(period["today"]["key"]).replace(tzinfo=ZoneInfo("America/Los_Angeles"))
    end = datetime.fromisoformat(period["today"]["endsAt"].replace("Z", "+00:00"))
    assert (end - start.astimezone(timezone.utc)).total_seconds() == expected_hours * 3600


def test_browser_timezone_header_is_allowed_for_configured_cors_origins(tmp_path):
    from hub.main import create_app

    app = create_app(make_settings(tmp_path, cors_origins=("https://dashboard.example",)))
    with TestClient(app) as client:
        response = client.options("/api/v1/tm/overview", headers={
            "Origin": "https://dashboard.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,x-cm-time-zone",
        })
        assert response.status_code == 200
        assert "x-cm-time-zone" in response.headers["access-control-allow-headers"].lower()
