"""Cancellation, stale responses and bounded readiness under real lock contention."""
from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from hub.body_limit import TmBodyLimitMiddleware
from hub.config import Settings
from hub.db import Database
from hub.main import create_app
from hub.models import MAX_USERS_PER_PUSH
from hub.tm_outbox import ensure_schema as ensure_outbox
from hub.tm_overview import build_tm_overview_router
from hub.tm_proxy import UpstreamUnavailable
from hub.tm_snapshots import ensure_schema as ensure_snapshots


def settings(tmp_path, **overrides):
    values = dict(api_key="a" * 32, access_token="b" * 32,
                  database_path=tmp_path / "audit.sqlite3", frontend_dir=tmp_path / "frontend",
                  max_records_per_push=500, tm_background_enabled=False)
    return Settings(**(values | overrides))


class ControlledCore:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.failed = False

    def request(self, _method, path):
        if self.failed:
            raise UpstreamUnavailable("injected outage")
        if path == "/api/stats":
            self.started.set()
            if not self.release.wait(3):
                raise RuntimeError("test did not release the upstream")
            return httpx.Response(200, json={"devices": [], "totals": {}})
        return httpx.Response(200, json={"daily": [], "devices": []})


@pytest.fixture
def overview(tmp_path):
    db = Database(tmp_path / "overview.sqlite3")
    ensure_snapshots(db)
    ensure_outbox(db)
    core = ControlledCore()
    router, cache = build_tm_overview_router(settings(tmp_path, tm_ingest_secret="c" * 32), db)
    endpoint = next(r.endpoint for r in router.routes if r.path == "/api/v1/tm/overview")
    request = Request({
        "type": "http", "headers": [(b"authorization", ("Bearer " + "b" * 32).encode())],
        "app": SimpleNamespace(state=SimpleNamespace(tm_core=core)),
    })
    yield core, cache, endpoint, request
    core.release.set()
    db.close()


def test_cancelled_owner_releases_refresh_and_followers_can_retry(overview):
    core, cache, endpoint, request = overview

    async def scenario():
        core.release.clear()
        owner = asyncio.create_task(endpoint(request))
        assert await asyncio.to_thread(core.started.wait, 2)
        follower = asyncio.create_task(endpoint(request))
        await asyncio.sleep(0)
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner
        with pytest.raises(HTTPException) as error:
            await asyncio.wait_for(follower, .5)
        assert error.value.status_code == 503
        assert cache._inflight is None
        core.release.set()
        response = await asyncio.wait_for(endpoint(request), 1)
        assert response["partial"] is False

    asyncio.run(scenario())


def test_cancelling_a_follower_does_not_cancel_another_request(overview):
    core, cache, endpoint, request = overview

    async def scenario():
        core.release.clear()
        owner = asyncio.create_task(endpoint(request))
        assert await asyncio.to_thread(core.started.wait, 2)
        first = asyncio.create_task(endpoint(request))
        second = asyncio.create_task(endpoint(request))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert not cache._inflight.cancelled()
        core.release.set()
        owner_result, follower_result = await asyncio.wait_for(asyncio.gather(owner, second), 1)
        assert follower_result == owner_result
        assert cache._inflight is None

    asyncio.run(scenario())


def test_waiter_timeout_does_not_poison_a_live_shared_result(overview, monkeypatch):
    _, cache, endpoint, request = overview
    monkeypatch.setattr("hub.tm_overview.OVERVIEW_REFRESH_TIMEOUT_SECONDS", .02)

    async def scenario():
        owned, shared = cache.claim_refresh()
        assert owned
        with pytest.raises(HTTPException) as error:
            await endpoint(request)
        assert error.value.status_code == 504
        assert not shared.done()
        response = {"totals": {"today": 42}}
        cache.finish_refresh(response)
        assert await shared == response

    asyncio.run(scenario())


def test_owner_timeout_allows_a_new_refresh(overview, monkeypatch):
    core, cache, endpoint, request = overview
    monkeypatch.setattr("hub.tm_overview.OVERVIEW_REFRESH_TIMEOUT_SECONDS", .03)

    async def scenario():
        core.release.clear()
        with pytest.raises(HTTPException) as error:
            await endpoint(request)
        assert error.value.status_code == 504
        assert cache._inflight is None
        core.release.set()
        monkeypatch.setattr("hub.tm_overview.OVERVIEW_REFRESH_TIMEOUT_SECONDS", 1)
        assert (await endpoint(request))["partial"] is False

    asyncio.run(scenario())


def test_stale_owner_and_followers_are_labelled_without_mutating_cache(overview):
    core, cache, endpoint, request = overview

    async def scenario():
        original = await endpoint(request)
        cache.invalidate()
        core.failed = True
        responses = await asyncio.gather(endpoint(request), endpoint(request))
        for response in responses:
            assert response["generated_at"] == original["generated_at"]
            assert response["partial"] is True
            assert response["partial_errors"][-1]["code"] == "overview_stale"
        assert original["partial"] is False
        assert original["partial_errors"] == []
        core.failed = False
        fresh = await endpoint(request)
        assert fresh["partial"] is False
        assert not any(row["code"] == "overview_stale" for row in fresh["partial_errors"])

    asyncio.run(scenario())


def test_stale_data_still_expires_after_the_age_cap(overview):
    core, cache, endpoint, request = overview

    async def scenario():
        await endpoint(request)
        cache.invalidate()
        cache._built_at = time.monotonic() - 61
        core.failed = True
        with pytest.raises(HTTPException) as error:
            await endpoint(request)
        assert error.value.status_code == 502

    asyncio.run(scenario())


def test_cancelled_build_finishing_late_cannot_replace_the_new_cache(overview, monkeypatch):
    _, cache, endpoint, request = overview
    first_started, release_first, first_finished = (threading.Event() for _ in range(3))
    calls = 0

    def build(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        result = {"build": calls, "partial": False, "partial_errors": []}
        if calls == 1:
            first_started.set()
            assert release_first.wait(3)
            first_finished.set()
        return result

    monkeypatch.setattr("hub.tm_overview.build_overview", build)

    async def scenario():
        old = asyncio.create_task(endpoint(request))
        assert await asyncio.to_thread(first_started.wait, 2)
        old.cancel()
        with pytest.raises(asyncio.CancelledError):
            await old
        try:
            fresh = await endpoint(request)
            assert fresh["build"] == 2
        finally:
            release_first.set()
        assert await asyncio.to_thread(first_finished.wait, 2)
        await asyncio.sleep(0)
        assert cache.get()["build"] == 2

    asyncio.run(scenario())


def test_probe_query_deadline_restores_connection_for_normal_transactions(tmp_path):
    db = Database(tmp_path / "probe.sqlite3")
    try:
        with pytest.raises(sqlite3.OperationalError, match="interrupted"):
            with db.probe_access(.02):
                db.fetchone("""WITH RECURSIVE numbers(n) AS (
                    VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100000000
                ) SELECT SUM(n) FROM numbers""")
        assert db.fetchone("PRAGMA busy_timeout")["timeout"] == 30000
        with db.transaction():
            db.execute("CREATE TABLE after_probe(value INTEGER)")
            db.execute("INSERT INTO after_probe VALUES (42)")
        assert db.fetchone("SELECT value FROM after_probe")["value"] == 42
    finally:
        db.close()


def test_failed_commit_does_not_leave_later_requests_in_an_uncommitted_batch(tmp_path):
    db = Database(tmp_path / "commit.sqlite3")
    connection = db._conn
    connection.execute("CREATE TABLE commit_proof(value INTEGER)")

    class FailFirstCommit:
        failed = False

        def __getattr__(self, name):
            return getattr(connection, name)

        def execute(self, sql, *args):
            if sql == "COMMIT" and not self.failed:
                self.failed = True
                raise sqlite3.OperationalError("injected commit I/O failure")
            return connection.execute(sql, *args)

    db._conn = FailFirstCommit()
    try:
        with pytest.raises(sqlite3.OperationalError, match="commit I/O"):
            with db.transaction():
                db.execute("INSERT INTO commit_proof VALUES (1)")
        assert not connection.in_transaction
        with db.transaction():
            db.execute("INSERT INTO commit_proof VALUES (2)")
        assert db.fetchall("SELECT value FROM commit_proof") == [{"value": 2}]
        assert not connection.in_transaction
    finally:
        db.close()


def test_readiness_returns_promptly_while_application_transaction_is_held(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        db = client.app.state.db
        acquired = threading.Event()
        release = threading.Event()

        def writer():
            with db.transaction():
                db.execute("INSERT INTO tm_meta(key, value) VALUES ('writer-proof', 'kept')")
                acquired.set()
                release.wait(5)

        thread = threading.Thread(target=writer)
        thread.start()
        assert acquired.wait(2)
        try:
            started = time.monotonic()
            response = client.get("/api/v1/health/ready")
            assert time.monotonic() - started < 2.5
            assert response.status_code == 503
            assert client.get("/api/v1/health/live").status_code == 200
        finally:
            release.set()
            thread.join(2)
        assert not thread.is_alive()
        assert db.fetchone("SELECT value FROM tm_meta WHERE key='writer-proof'")["value"] == "kept"
        assert client.get("/api/v1/health/ready").status_code == 200


def test_readiness_shortens_external_lock_wait_and_restores_normal_policy(tmp_path):
    cfg = settings(tmp_path)
    with TestClient(create_app(cfg)) as client:
        db = client.app.state.db
        blocker = sqlite3.connect(str(cfg.database_path), isolation_level=None)
        try:
            blocker.execute("BEGIN IMMEDIATE")
            started = time.monotonic()
            response = client.get("/api/v1/health/ready")
            assert time.monotonic() - started < 2.5
            assert response.status_code == 503
            assert response.json()["components"]["sqlite_write"]["ok"] is False
        finally:
            blocker.execute("ROLLBACK")
            blocker.close()
        assert db.fetchone("PRAGMA busy_timeout")["timeout"] == 30000
        assert client.get("/api/v1/health/ready").status_code == 200


def test_user_limit_rejects_whole_push_without_partial_writes(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        headers = {"Authorization": "Bearer " + "a" * 32}
        body = {"device": {"id": "limited-device"},
                "users": [{"id": str(n)} for n in range(MAX_USERS_PER_PUSH + 1)]}
        response = client.post("/api/v1/sync/push", json=body, headers=headers)
        assert response.status_code == 400
        assert client.app.state.db.fetchone("SELECT COUNT(*) AS n FROM users")["n"] == 0
        assert client.app.state.db.fetchone("SELECT COUNT(*) AS n FROM devices")["n"] == 0
        body["users"].pop()
        response = client.post("/api/v1/sync/push", json=body, headers=headers)
        assert response.status_code == 200
        assert response.json()["users_upserted"] == MAX_USERS_PER_PUSH


def test_body_limit_disconnect_does_not_try_to_respond_or_invoke_app():
    async def scenario():
        async def receive():
            return {"type": "http.disconnect"}

        async def unexpected(*_args):
            pytest.fail("a disconnected upload must not send a response or invoke the app")

        await TmBodyLimitMiddleware(unexpected)(
            {"type": "http", "path": "/api/ingest"}, receive, unexpected
        )

    asyncio.run(scenario())
