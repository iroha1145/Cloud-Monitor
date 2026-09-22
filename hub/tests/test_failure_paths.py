"""失败路径回归：损坏隔离、卡死自愈、上游错误文案、降级与钳制。

这些路径的共同点是「回归之后只会在生产环境出事，而且只能靠人工发现」。
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
from fastapi import Request

from conftest import make_settings, seed_bucket, widget_style_payload
from hub.db import Database
from hub import tm_outbox as outbox, tm_proxy, tm_snapshots as snapshots, tm_update
from hub.tm_forwarding import ForwardingQueue
from hub.tm_overview import activity_report, build_tm_overview_router


def _db(tmp_path, name="failure.sqlite3"):
    db = Database(tmp_path / name)
    snapshots.ensure_schema(db)
    outbox.ensure_schema(db)
    return db


def test_replay_quarantines_a_corrupt_stored_payload_but_completes_the_rest(tmp_path):
    db = _db(tmp_path)
    outbox.record_pending(db, request_id="bad", device_id="dev", payload={"deviceId": "dev"})
    outbox.record_pending(db, request_id="good", device_id="dev", payload=widget_style_payload("dev", tz="UTC"))
    outbox.save_normalized(db, "bad", {"periods": {"today": {"totalTokens": 1}}})
    outbox.save_normalized(db, "good", outbox.record_from_payload(widget_style_payload("dev", tz="UTC")))
    # 磁盘半写/进程崩溃后的样子：审计 JSON 完好，原始载荷已损坏
    db.execute("UPDATE tm_ingest_outbox SET payload_json='{corrupt' WHERE request_id='bad'")
    result = outbox.replay_pending(db, None)
    assert result["rejected"] == 1
    assert result["completed"] == 1
    bad = db.fetchone("SELECT state, last_error FROM tm_ingest_outbox WHERE request_id='bad'")
    assert bad["state"] == "rejected"
    assert "not JSON" in bad["last_error"]
    good = db.fetchone("SELECT state FROM tm_ingest_outbox WHERE request_id='good'")
    assert good["state"] == "done"
    db.close()


def test_forwarding_quarantines_a_corrupt_stored_payload(tmp_path):
    db = _db(tmp_path, "forward.sqlite3")
    queue = ForwardingQueue(db, max_pending=10)
    request_id = queue.enqueue(widget_style_payload("dev-corrupt", tz="UTC"))
    db.execute(
        "UPDATE tm_ingest_outbox SET forward_payload_json='{corrupt' WHERE request_id=?",
        (request_id,),
    )
    attempt = queue.process_device(None, "dev-corrupt")
    assert attempt.request_id == request_id
    assert attempt.error_code == "upstream_retry_expired"
    assert "损坏" in attempt.message
    row = db.fetchone(
        "SELECT state, terminal_reason FROM tm_ingest_outbox WHERE request_id=?",
        (request_id,),
    )
    assert row["state"] == "expired"
    assert row["terminal_reason"] == "forward_payload_invalid"
    db.close()


def test_stuck_running_update_marks_itself_timed_out(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    stale = (datetime.now(timezone.utc) - timedelta(minutes=31)).strftime("%Y-%m-%dT%H:%M:%SZ")
    (control / "status.json").write_text(json.dumps({
        "id": "stuck", "state": "running", "ref": "main", "updated_at": stale,
    }))
    service = tm_update.UpdateService(make_settings(tmp_path, cm_update_dir=control))
    job = service.read_job()
    assert job["state"] == "error"
    assert "超时" in job["message"]


def test_fresh_running_update_is_not_prematurely_timed_out(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    fresh = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (control / "status.json").write_text(json.dumps({
        "id": "fresh", "state": "running", "ref": "main", "updated_at": fresh,
    }))
    service = tm_update.UpdateService(make_settings(tmp_path, cm_update_dir=control))
    assert service.read_job()["state"] == "running"


def test_running_update_with_an_unreadable_timestamp_also_times_out(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    (control / "status.json").write_text(json.dumps({
        "id": "garbled", "state": "running", "ref": "main", "updated_at": "not-a-date",
    }))
    service = tm_update.UpdateService(make_settings(tmp_path, cm_update_dir=control))
    job = service.read_job()
    assert job["state"] == "error"
    assert "超时" in job["message"]


def test_gh_error_message_branches():
    assert tm_update._gh_error(200, {}) == ""
    assert tm_update._gh_error(0, {}) == "无法连接 GitHub"
    assert tm_update._gh_error(403, {}) == "GitHub API 限额已用尽，稍后重试或配置 GITHUB_TOKEN"
    assert tm_update._gh_error(404, {}) == "仓库或 Release 不存在"
    assert tm_update._gh_error(500, {"message": "boom"}) == "boom"
    assert tm_update._gh_error(500, {}) == "GitHub 返回 500"


def test_github_403_surfaces_the_rate_limit_message(tmp_path):
    service = tm_update.UpdateService(make_settings(tmp_path))
    service._fetch = lambda _url: (403, {"message": "API rate limit exceeded"})
    payload = service.check(force=True)
    assert payload["github_error"] == "GitHub API 限额已用尽，稍后重试或配置 GITHUB_TOKEN"


def test_github_404_on_commits_surfaces_the_missing_repo_message(tmp_path):
    service = tm_update.UpdateService(make_settings(tmp_path))

    def fetch(url):
        if "/releases" in url:
            return (200, [])
        return (404, {"message": "Not Found"})

    service._fetch = fetch
    payload = service.check(force=True)
    assert payload["github_error"] == "仓库或 Release 不存在"


class _HealthyCore:
    def request(self, _method, path):
        if path == "/api/stats":
            return httpx.Response(200, json={"devices": [], "totals": {}})
        return httpx.Response(200, json={"daily": [], "devices": []})


def test_activity_sqlite_failure_degrades_to_activity_unavailable(tmp_path, monkeypatch):
    db = _db(tmp_path, "overview.sqlite3")
    router, _cache = build_tm_overview_router(
        make_settings(tmp_path, tm_ingest_secret="c" * 32), db
    )
    endpoint = next(r.endpoint for r in router.routes if r.path == "/api/v1/tm/overview")
    request = Request({
        "type": "http", "headers": [(b"authorization", ("Bearer " + "b" * 32).encode())],
        "app": SimpleNamespace(state=SimpleNamespace(tm_core=_HealthyCore())),
    })

    def boom(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    import hub.tm_overview as overview_mod

    monkeypatch.setattr(overview_mod, "activity_report", boom)
    overview = asyncio.run(endpoint(request))
    assert overview["partial"] is True
    assert any(e["code"] == "activity_unavailable" for e in overview["partial_errors"])
    # 降级形状：空数据但结构完整，不把异常伪装成「没有活动」
    assert overview["activity"]["hourly"] == []
    assert overview["activity"]["daily"] == []
    assert overview["activity"]["coverage"] is None
    db.close()


def test_coverage_clamp_caps_an_oversampled_slot_at_100(tmp_path):
    db = _db(tmp_path, "coverage.sqlite3")
    day = "2026-08-23"
    # 两个样本落进同一个 5 分钟槽位：observed=2、expected=1，不钳制会得到 200
    seed_bucket(db, "dev", day, f"{day}T00:00:00.000Z", 100, tz="UTC")
    seed_bucket(db, "dev", day, f"{day}T00:01:00.000Z", 150, tz="UTC")
    now = datetime(2026, 8, 23, 1, 0, tzinfo=timezone.utc)
    coverage = activity_report(db, "UTC", now=now)["coverage"]
    assert coverage["observed_buckets"] == 2
    assert coverage["expected_buckets"] == 1
    assert coverage["coverage_percent"] == 100.0
    db.close()


def test_replay_stops_the_round_when_the_floor_raises_connect_error(tmp_path, monkeypatch):
    """上游不可达按类型中止整轮（不看错误文案），且不按失败计次。"""
    db = _db(tmp_path, "abort.sqlite3")
    outbox.record_pending(db, request_id="keep", device_id="dev", payload=widget_style_payload("dev", tz="UTC"))
    outbox.save_normalized(db, "keep", outbox.record_from_payload(widget_style_payload("dev", tz="UTC")))

    def unreachable(*_args, **_kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(snapshots, "write_snapshot", unreachable)
    result = outbox.replay_pending(db, None)
    assert result["stopped_by"] == "upstream_unavailable"
    row = db.fetchone("SELECT state, attempts FROM tm_ingest_outbox WHERE request_id='keep'")
    assert row["state"] == "pending"
    assert int(row["attempts"] or 0) == 0
    db.close()


# ---- 后台维护循环：失败既不能冻结排期，也不能让线程退出 ----

def _loop_harness(tmp_path, monkeypatch, *, rounds=6):
    """确定性地驱动 TmBackground._loop：假时钟 + 记录每次等待时长，跑满 rounds 圈即停。"""
    db = _db(tmp_path, "loop.sqlite3")
    worker = tm_proxy.TmBackground(make_settings(tmp_path, tm_background_interval=300), db, object())
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(tm_proxy, "time", SimpleNamespace(monotonic=lambda: clock.now))
    delays = []

    def wait(delay):
        delays.append(delay)
        clock.now += delay
        if len(delays) >= rounds:
            worker._stop.set()
        return False

    worker._wake = SimpleNamespace(wait=wait, clear=lambda: None, set=lambda: None)
    return worker, clock, delays


def test_failed_maintenance_still_schedules_the_next_one(tmp_path, monkeypatch):
    worker, _clock, delays = _loop_harness(tmp_path, monkeypatch)

    def replay_on_a_damaged_database(*_args, **_kwargs):
        raise sqlite3.DatabaseError("database disk image is malformed")

    monkeypatch.setattr(tm_proxy, "replay_pending", replay_on_a_damaged_database)
    worker._loop()
    # 排期若被冻结，等待时长会塌到 0.1 秒下限：每秒十次重放、十条警告
    assert min(delays) >= 299, delays


def test_unreadable_forwarding_schedule_keeps_the_worker_alive(tmp_path, monkeypatch, caplog):
    worker, clock, delays = _loop_harness(tmp_path, monkeypatch)
    replays = []
    monkeypatch.setattr(tm_proxy, "replay_pending", lambda *_a, **_k: replays.append(clock.now))

    def unreadable(_default):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(worker.forwarding, "next_delay", unreadable)
    with caplog.at_level(logging.WARNING, logger="tm-proxy"):
        worker._loop()  # 读不到转发排期时线程不得退出，否则重放与转发静默停摆
    assert len(delays) == 6
    assert min(delays) >= 299, delays
    assert replays, "维护应按原节奏继续"
    assert "转发排期" in caplog.text


def test_housekeeping_pragma_failure_is_logged_and_contained(tmp_path, monkeypatch, caplog):
    db = _db(tmp_path)
    real_execute = db.execute
    failing = ("PRAGMA INCREMENTAL_VACUUM", "PRAGMA WAL_CHECKPOINT")

    def execute(sql, *args, **kwargs):
        if sql.strip().upper().startswith(failing):
            raise sqlite3.DatabaseError("database disk image is malformed")
        return real_execute(sql, *args, **kwargs)

    monkeypatch.setattr(db, "execute", execute)
    monkeypatch.setattr(outbox, "prune_done", lambda _db: 1)  # 让增量回收那一步也执行
    with caplog.at_level(logging.WARNING, logger="tm-outbox"):
        stats = outbox.replay_pending(db, object())
    assert stats["checked"] == 0  # 收尾维护失败不得让整轮重放抛出
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2, [r.getMessage() for r in warnings]


def test_forwarding_failure_backs_off_instead_of_spinning(tmp_path, monkeypatch, caplog):
    worker, _clock, delays = _loop_harness(tmp_path, monkeypatch, rounds=8)
    monkeypatch.setattr(tm_proxy, "replay_pending", lambda *_a, **_k: None)
    # 磁盘满或只读：到期行的排期写不回去，next_delay 就一直报它已到期
    monkeypatch.setattr(worker.forwarding, "next_delay", lambda _default: 0.1)

    def disk_full(*_args, **_kwargs):
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(worker.forwarding, "process_due", disk_full)
    with caplog.at_level(logging.WARNING, logger="tm-proxy"):
        worker._loop()
    # 出错后每次等待翻倍，封顶维护间隔；不退避就是每 0.1 秒一圈、一条警告
    assert delays == [0.1, 5, 10, 20, 40, 80, 160, 300], delays
    assert caplog.text.count("转发处理异常") == len(delays) - 1  # 最后一次等待时收到停止信号


def test_forwarding_failure_does_not_skip_due_maintenance(tmp_path, monkeypatch):
    worker, clock, _delays = _loop_harness(tmp_path, monkeypatch, rounds=3)
    replays = []
    monkeypatch.setattr(tm_proxy, "replay_pending", lambda *_a, **_k: replays.append(clock.now))

    def disk_full(*_args, **_kwargs):
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(worker.forwarding, "process_due", disk_full)
    worker._loop()
    # 转发出错不能把到期的重放、清理、检查点一起拖掉
    assert replays == [1300.0, 1600.0], replays

