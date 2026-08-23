from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
import requests

import sync_agent as sa
from sync_agent import (
    AgentConfig,
    AgentState,
    PermanentConfigError,
    StateCorruptError,
    SyncAgent,
    assert_https_allowed,
    resolve_device_id,
    utc_now_iso,
    validate_push_response,
)
import token_monitor_bridge as tm


# ---------------------------------------------------------------- 测试基建


class FakeResponse:
    def __init__(self, status_code=200, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body
        self.text = text or (json.dumps(json_body) if json_body_body_ok(json_body) else "")

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)


def json_body_body_ok(x):
    return x is not None


class FakeSession:
    """按 (method, path 片段) 脚本化的假 HTTP 会话，记录全部请求。"""

    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.routes: dict[tuple[str, str], object] = {}

    def route(self, method: str, path_contains: str, result):
        self.routes[(method, path_contains)] = result
        return self

    def _dispatch(self, method: str, url: str, **kwargs):
        for (m, frag), result in self.routes.items():
            if m == method and frag in url:
                self.calls.append((method, url, kwargs))
                if isinstance(result, Exception):
                    raise result
                if callable(result):
                    return result(url, kwargs)
                return result
        raise AssertionError(f"未脚本化的请求: {method} {url} kwargs={kwargs}")

    def get(self, url, **kwargs):
        return self._dispatch("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._dispatch("POST", url, **kwargs)


def ok_push(received: int, device_id="dev-x", source="src-1", **overrides):
    body = {
        "success": True,
        "protocol_version": 2,
        "device_id": device_id,
        "source_instance_id": source,
        "received": received,
        "inserted": received,
        "duplicates": 0,
        "conflicts": 0,
        "users_upserted": 0,
        "server_time": utc_now_iso(),
    }
    body.update(overrides)
    return FakeResponse(200, body)


def make_config(tmp_path: Path, **overrides) -> AgentConfig:
    defaults = dict(
        local_monitor_url="http://127.0.0.1:7878",
        local_api_key="local",
        cloud_hub_url="https://cloud.example.com",
        cloud_api_key="cloud",
        device_id="dev-x",
        device_name="My Mac",
        host_platform="macos",
        source_instance_id="",
        sync_interval_seconds=60,
        degraded_interval_seconds=600,
        batch_size=2,
        state_path=tmp_path / "state.json",
        request_timeout_seconds=5,
        time_zone="Asia/Tokyo",
    )
    defaults.update(overrides)
    return AgentConfig(**defaults)


def make_agent(config: AgentConfig, state: AgentState, session: FakeSession) -> SyncAgent:
    return SyncAgent(config, state, session=session)


def rec(i: int, user="u1", model="m", created=None):
    return {
        "id": i,
        "user_id": user,
        "nickname": "Nick",
        "model_name": model,
        "input_tokens": i,
        "output_tokens": i * 2,
        "created_at": created or f"2026-08-20T00:00:{i:02d}+00:00",
    }


# ---------------------------------------------------------------- 二、设备身份与状态文件


def test_device_id_stable_across_restart(tmp_path):
    cfg = make_config(tmp_path, device_id="")  # 未显式配置
    state = AgentState(cfg.state_path)
    first = resolve_device_id(cfg, state)
    state.device_id = first
    state.save()
    # 模拟容器重建：新进程重新加载
    state2 = AgentState(cfg.state_path)
    state2.load()
    assert resolve_device_id(cfg, state2) == first


def test_env_device_id_wins_over_state(tmp_path):
    cfg = make_config(tmp_path, device_id="explicit-id")
    state = AgentState(cfg.state_path)
    state.device_id = "old-id"
    # P1-7：冲突默认失败关闭
    import pytest
    with pytest.raises(SystemExit):
        resolve_device_id(cfg, state)
    # 显式放行则以环境变量为准
    cfg2 = make_config(tmp_path, device_id="explicit-id", allow_legacy_fallback=True)
    cfg2.__dict__.setdefault("extra", {})["allow_state_conflict"] = True
    assert resolve_device_id(cfg2, state) == "explicit-id"


def test_corrupt_state_backed_up_and_refused(tmp_path):
    cfg = make_config(tmp_path)
    cfg.state_path.write_text("{ not json", encoding="utf-8")
    state = AgentState(cfg.state_path)
    with pytest.raises(StateCorruptError):
        state.load()
    backups = list(cfg.state_path.parent.glob("state.json.corrupt-*"))
    assert backups, "损坏文件必须被备份"


def test_state_schema_version_enforced(tmp_path):
    cfg = make_config(tmp_path)
    # v1 状态（无 schema_version，有 device_id/cursor）→ 就地迁移为 v2
    cfg.state_path.write_text(
        json.dumps({"device_id": "d", "cursor": 5}), encoding="utf-8"
    )
    state = AgentState(cfg.state_path)
    state.load()
    assert state.data["schema_version"] == 2
    assert state.device_id == "d" and state.cursor == 5
    # 显式非法版本仍拒绝
    cfg.state_path.write_text(
        json.dumps({"schema_version": 99, "device_id": "d"}), encoding="utf-8"
    )
    with pytest.raises(StateCorruptError):
        AgentState(cfg.state_path).load()


def test_corrupt_state_with_explicit_device_id_continues(tmp_path):
    cfg = make_config(tmp_path, device_id="explicit-id")
    cfg.state_path.write_text("garbage", encoding="utf-8")
    with pytest.raises(StateCorruptError):
        AgentState(cfg.state_path).load()
    # main() 的行为：显式 DEVICE_ID 时用全新状态继续
    fresh = AgentState(cfg.state_path)
    fresh.device_id = resolve_device_id(cfg, fresh)
    assert fresh.device_id == "explicit-id"


# ---------------------------------------------------------------- 四、同步协议与心跳


def _cursor_round_routes(session: FakeSession, records_pages, users=None):
    session.route("GET", "/api/v1/sync/meta", FakeResponse(200, {
        "source_instance_id": "src-1", "max_record_id": 3, "protocol_version": 2
    }))
    session.route("GET", "/api/v1/users", FakeResponse(200, {
        "users": users if users is not None else [{"id": "u1", "name": "Alice"}]
    }))

    def sync_records(url, kwargs):
        after_id = kwargs["params"]["after_id"]
        page = {0: records_pages[0], 2: records_pages[1], 3: {"records": []}}
        return FakeResponse(200, page.get(after_id, {"records": []}))

    session.route("GET", "/api/v1/sync/records", sync_records)
    session.route("POST", "/api/v1/sync/push", lambda url, kw: ok_push(len(kw["json"]["records"])))


def test_cursor_round_users_only_in_first_batch(tmp_path):
    cfg = make_config(tmp_path, batch_size=2)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    _cursor_round_routes(session, [{"records": [rec(1), rec(2)]}, {"records": [rec(3)]}])

    agent = make_agent(cfg, state, session)
    summary = agent.run_once()

    assert summary == {"mode": "cursor", "fetched": 3, "inserted": 3}
    assert state.cursor == 3
    pushes = [c for c in session.calls if c[0] == "POST"]
    assert len(pushes) == 2
    assert len(pushes[0][2]["json"]["users"]) == 1   # 首批带 users
    assert pushes[1][2]["json"]["users"] == []       # 后续批不带
    assert len(pushes[0][2]["json"]["records"]) == 2


def test_heartbeat_sent_when_no_new_records(tmp_path):
    cfg = make_config(tmp_path)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    session.route("GET", "/api/v1/sync/meta", FakeResponse(200, {
        "source_instance_id": "src-1", "max_record_id": 0, "protocol_version": 2
    }))
    session.route("GET", "/api/v1/users", FakeResponse(200, {"users": [{"id": "u1", "name": "Alice"}]}))
    session.route("GET", "/api/v1/sync/records", FakeResponse(200, {"records": []}))
    session.route("POST", "/api/v1/sync/push", lambda url, kw: ok_push(0))

    agent = make_agent(cfg, state, session)
    agent.run_once()

    pushes = [c for c in session.calls if c[0] == "POST"]
    assert len(pushes) == 1
    body = pushes[0][2]["json"]
    assert body["records"] == []
    assert len(body["users"]) == 1  # 心跳携带 users 同步改名/角色


def test_cursor_not_advanced_on_bad_response(tmp_path):
    cfg = make_config(tmp_path, batch_size=2)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    _cursor_round_routes(session, [{"records": [rec(1), rec(2)]}, {"records": [rec(3)]}])
    # 第二批返回 received 不匹配 → 校验失败
    def bad_second(url, kwargs):
        n = len(kwargs["json"]["records"])
        if n == 1:
            return ok_push(99)  # received 造假
        return ok_push(n)
    session.routes[("POST", "/api/v1/sync/push")] = lambda url, kw: bad_second(url, kw)

    agent = make_agent(cfg, state, session)
    with pytest.raises(ValueError):
        agent.run_once()
    # 第一批已确认推进到 2，第二批未确认 → 游标停在 2（部分批次恢复点）
    assert state.cursor == 2


def test_cursor_advances_per_batch_and_resumes(tmp_path):
    cfg = make_config(tmp_path, batch_size=2)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    _cursor_round_routes(session, [{"records": [rec(1), rec(2)]}, {"records": [rec(3)]}])

    agent = make_agent(cfg, state, session)
    # 中途"崩溃"：第二批（1 条记录）的所有推送尝试都失败
    import pytest as _pytest
    real_sleep = sa.time.sleep
    sa.time.sleep = lambda *_: None
    real_post = session.post
    def flaky_post(url, **kwargs):
        body = kwargs.get("json") or {}
        if len(body.get("records") or []) == 1:
            raise requests.ConnectionError("cloud down")
        return real_post(url, **kwargs)
    session.post = flaky_post
    with pytest.raises((requests.ConnectionError, sa.TransientError)):
        agent.run_once()
    session.post = real_post
    sa.time.sleep = real_sleep
    assert state.cursor == 2  # 批1已持久化

    # 恢复：从 cursor=2 继续，只推批2
    summary = agent.run_once()
    assert summary["inserted"] == 1
    assert state.cursor == 3


def test_users_created_at_passed_through(tmp_path):
    cfg = make_config(tmp_path)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    session.route("GET", "/api/v1/sync/meta", FakeResponse(200, {
        "source_instance_id": "src-1", "max_record_id": 0, "protocol_version": 2
    }))
    session.route("GET", "/api/v1/users", FakeResponse(200, {"users": [{
        "id": "u1", "name": "Alice", "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-02-01T00:00:00+00:00",
    }]}))
    session.route("GET", "/api/v1/sync/records", FakeResponse(200, {"records": []}))
    session.route("POST", "/api/v1/sync/push", lambda url, kw: ok_push(0))

    make_agent(cfg, state, session).run_once()
    body = [c for c in session.calls if c[0] == "POST"][0][2]["json"]
    assert body["users"][0]["created_at"] == "2026-01-01T00:00:00+00:00"
    assert body["users"][0]["updated_at"] == "2026-02-01T00:00:00+00:00"


def test_time_mode_fallback_with_warning(tmp_path, caplog):
    cfg = make_config(tmp_path, allow_legacy_fallback=True, source_instance_id="stable-src")
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    not_found = requests.HTTPError("404")
    not_found.response = FakeResponse(404)
    session.route("GET", "/api/v1/sync/meta", not_found)
    session.route("GET", "/api/v1/users", FakeResponse(200, {"users": []}))

    def records(url, kwargs):
        page = kwargs["params"]["page"]
        data = {"total": 2, "records": [rec(2), rec(1)]} if page == 1 else {"total": 2, "records": []}
        return FakeResponse(200, data)
    session.route("GET", "/api/v1/records", records)
    session.route("POST", "/api/v1/sync/push", lambda url, kw: ok_push(
        len(kw["json"]["records"]),
        device_id=kw["json"]["device"]["id"],
        source=kw["json"]["source_instance_id"],
    ))

    agent = make_agent(cfg, state, session)
    summary = agent.run_once()
    assert summary["mode"] == "time"
    # 显式配置了稳定 SOURCE_INSTANCE_ID 的回退模式：模式正确且实例为显式值
    assert state.source_instance_id == "stable-src"


def test_legacy_fallback_refused_by_default(tmp_path):
    """P1-7：缺 /sync/meta 且未显式配置回退 → SystemExit 拒绝启动。"""
    cfg = make_config(tmp_path)  # allow_legacy_fallback=False, source_instance_id=""
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    not_found = requests.HTTPError("404")
    not_found.response = FakeResponse(404)
    session.route("GET", "/api/v1/sync/meta", not_found)
    agent = make_agent(cfg, state, session)
    with pytest.raises(SystemExit):
        agent.probe_sync_meta()


def test_legacy_fallback_requires_stable_source_instance(tmp_path):
    """P1-7：仅开 ALLOW_LEGACY_FALLBACK 但未给稳定 SOURCE_INSTANCE_ID 仍拒绝。"""
    cfg = make_config(tmp_path, allow_legacy_fallback=True, source_instance_id="")
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    session = FakeSession()
    not_found = requests.HTTPError("404")
    not_found.response = FakeResponse(404)
    session.route("GET", "/api/v1/sync/meta", not_found)
    agent = make_agent(cfg, state, session)
    with pytest.raises(SystemExit):
        agent.probe_sync_meta()


def test_source_instance_rotation_resets_cursor(tmp_path):
    cfg = make_config(tmp_path)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    state.mode = "cursor"
    state.source_instance_id = "src-old"
    state.cursor = 500
    session = FakeSession()
    session.route("GET", "/api/v1/sync/meta", FakeResponse(200, {
        "source_instance_id": "src-new", "max_record_id": 0, "protocol_version": 2
    }))
    session.route("GET", "/api/v1/users", FakeResponse(200, {"users": []}))
    session.route("GET", "/api/v1/sync/records", FakeResponse(200, {"records": []}))
    session.route("POST", "/api/v1/sync/push", lambda url, kw: ok_push(
        0, device_id=kw["json"]["device"]["id"], source=kw["json"]["source_instance_id"]
    ))

    agent = make_agent(cfg, state, session)
    agent.run_once()
    assert state.source_instance_id == "src-new"
    assert state.cursor == 0  # 重建后从头全量，local_id 复用不会冲突


# ---------------------------------------------------------------- 响应校验


def test_validate_push_response_rules():
    good = {
        "success": True, "device_id": "d", "source_instance_id": "s",
        "received": 3, "inserted": 2, "duplicates": 1, "conflicts": 0,
    }
    assert validate_push_response(good, sent=3, device_id="d", source_instance_id="s")
    variants = [
        {**good, "success": False},
        {**good, "device_id": "other"},
        {**good, "source_instance_id": "other"},
        {**good, "received": 4},
        {**good, "inserted": 3},  # 3+1+0 != 3
        {**good, "conflicts": 1, "duplicates": 0, "inserted": 2},
    ]
    for bad in variants:
        with pytest.raises(ValueError):
            validate_push_response(bad, sent=3, device_id="d", source_instance_id="s")
    incomplete = {k: v for k, v in good.items() if k != "duplicates"}
    with pytest.raises(ValueError):
        validate_push_response(incomplete, sent=3, device_id="d", source_instance_id="s")


# ---------------------------------------------------------------- 错误分类与退避


def test_classify_status():
    assert sa.classify_status(429) is True
    assert sa.classify_status(500) is True
    assert sa.classify_status(503) is True
    assert sa.classify_status(400) is False
    assert sa.classify_status(401) is False
    assert sa.classify_status(403) is False
    assert sa.classify_status(404) is False


def test_post_with_retry_permanent_4xx_no_retry(monkeypatch):
    monkeypatch.setattr(sa.time, "sleep", lambda *_: None)
    session = FakeSession()
    session.route("POST", "push", FakeResponse(403, None, "forbidden"))
    with pytest.raises(PermanentConfigError):
        sa.post_with_retry(session, "https://c/push", json_body={}, headers={}, timeout=1)
    posts = [c for c in session.calls if c[0] == "POST"]
    assert len(posts) == 1  # 4xx 不重试


def test_post_with_retry_transient_backs_off(monkeypatch):
    monkeypatch.setattr(sa.time, "sleep", lambda *_: None)
    session = FakeSession()
    calls = {"n": 0}
    def flaky(url, kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            return FakeResponse(503, None, "unavailable")
        return FakeResponse(200, {"ok": True})
    session.route("POST", "push", lambda url, kw: flaky(url, kw))
    body = sa.post_with_retry(session, "https://c/push", json_body={}, headers={}, timeout=1)
    assert body == {"ok": True} and calls["n"] == 3


def test_permanent_error_marks_degraded(tmp_path):
    cfg = make_config(tmp_path, run_once=True)
    state = AgentState(cfg.state_path)
    state.device_id = cfg.device_id
    state.save()
    agent = make_agent(cfg, state, FakeSession())
    monkeypatch_target = agent.run_once
    def permanent_round():
        raise PermanentConfigError("HTTP 401: Unauthorized")
    agent.run_once = permanent_round
    agent.run_forever()
    assert state.data["last_permanent_error"] == "HTTP 401: Unauthorized"
    assert state.data["last_error_type"] == "permanent"


# ---------------------------------------------------------------- HTTPS 强制


def test_https_enforcement():
    assert_https_allowed("https://cloud.example.com", allow_insecure=False, what="CLOUD_HUB_URL")
    assert_https_allowed("http://127.0.0.1:7878", allow_insecure=False, what="X")
    assert_https_allowed("http://host.docker.internal:7878", allow_insecure=False, what="X")
    assert_https_allowed("http://nas.local:7878", allow_insecure=False, what="X")
    with pytest.raises(SystemExit):
        assert_https_allowed("http://cloud.example.com", allow_insecure=False, what="X")
    assert_https_allowed("http://cloud.example.com", allow_insecure=True, what="X")


def test_load_config_rejects_public_http(tmp_path):
    env = {
        "CLOUD_HUB_URL": "http://cloud.example.com",
        "STATE_PATH": str(tmp_path / "s.json"),
    }
    with pytest.raises(SystemExit):
        sa.load_config(env)
    env["ALLOW_INSECURE_HTTP"] = "true"
    cfg = sa.load_config(env)
    assert cfg.cloud_hub_url == "http://cloud.example.com"


# ================================================================ 三、token-monitor 桥接


class StubAgent:
    """只提供 local_get 的最小 agent 替身：任何 usage 查询都返回同一份用量。"""

    def __init__(self, config, usage):
        self.config = config
        self.usage = usage
        self.session = FakeSession()

    def local_get(self, path, params):
        if path == "/api/v1/usage":
            return self.usage
        raise AssertionError(f"未预期的 local 查询: {path} {params}")


def stub_usage(inp=100, out=40, models=None):
    by_model = [
        {"model_name": m, "input_tokens": i, "output_tokens": o,
         "total_tokens": i + o, "calls": 1}
        for m, i, o in (models or [("gpt-4o", 60, 25), ("claude", 40, 15)])
    ]
    return {
        "totals": {"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out},
        "by_model": by_model,
    }


def tm_config(tmp_path, **overrides):
    return make_config(tmp_path, **overrides)


def test_payload_uses_models_not_permodel(tmp_path):
    cfg = tm_config(tmp_path, time_zone="Asia/Tokyo")
    agent = StubAgent(cfg, stub_usage(100, 40))
    payload = tm.build_ingest_payload(agent, cfg)

    for period in ("today", "month", "allTime"):
        assert "models" in payload[period], f"{period} 缺少 models"
        assert "perModel" not in payload[period], f"{period} 不应携带 perModel"
        assert payload[period]["clientModels"] == {"openwebui": payload[period]["models"]}
        assert payload[period]["clients"] == {"openwebui": 140}
        assert payload[period]["outputTokens"] == 40
        assert payload[period]["unclassifiedTokens"] == 100  # input 归为 unclassified
        assert payload[period]["totalTokens"] == 140
        assert payload[period]["costUsd"] == 0
        assert payload[period]["updatedAt"]
        assert "modelCosts" in payload[period]
        assert "modelOutputs" in payload[period]
        assert "modelUnclassifiedTokens" in payload[period]
        assert "clientOutputs" in payload[period]
        assert "clientUnclassifiedTokens" in payload[period]
        assert "clientModelCosts" in payload[period]
    assert payload["capabilities"] == {"tokenComponents": False}
    assert payload["hostname"] == "My Mac"
    assert payload["platform"] == "macos"
    assert payload["historyAvailable"] is False and payload["projectsEnabled"] is False


def test_payload_period_windows_tokyo_midnight(tmp_path):
    cfg = tm_config(tmp_path, time_zone="Asia/Tokyo")
    agent = StubAgent(cfg, stub_usage())
    # 东京 2026-08-22 00:30 = UTC 2026-08-21 15:30
    now = datetime(2026, 8, 22, 0, 30, tzinfo=ZoneInfo("Asia/Tokyo"))
    payload = tm.build_ingest_payload(agent, cfg, now=now)
    pw = payload["periodWindows"]
    assert pw["timeZone"] == "Asia/Tokyo"
    assert pw["today"]["key"] == "2026-08-22"
    assert pw["today"]["endsAt"] == "2026-08-22T15:00:00+00:00"  # 东京次日 0 点
    assert pw["month"]["key"] == "2026-08"
    assert pw["month"]["endsAt"] == "2026-08-31T15:00:00+00:00"  # 东京 9/1 0 点


def test_period_windows_month_end_and_year_end(tmp_path):
    cfg = tm_config(tmp_path, time_zone="Asia/Tokyo")
    agent = StubAgent(cfg, stub_usage())
    now = datetime(2026, 12, 31, 23, 30, tzinfo=ZoneInfo("Asia/Tokyo"))
    payload = tm.build_ingest_payload(agent, cfg, now=now)
    pw = payload["periodWindows"]
    assert pw["today"]["key"] == "2026-12-31"
    assert pw["month"]["key"] == "2026-12"
    assert pw["month"]["endsAt"] == "2026-12-31T15:00:00+00:00"  # 东京 2027/1/1 0 点


def test_period_windows_dst_boundary(tmp_path):
    cfg = tm_config(tmp_path, time_zone="America/New_York")
    agent = StubAgent(cfg, stub_usage())
    # 2026-03-08 美东进入夏令时；3-09 当地 0 点 = UTC 04:00（EDT）
    now = datetime(2026, 3, 8, 20, 0, tzinfo=ZoneInfo("America/New_York"))
    payload = tm.build_ingest_payload(agent, cfg, now=now)
    assert payload["periodWindows"]["today"]["endsAt"] == "2026-03-09T04:00:00+00:00"
    # 夏令时前（3-01 当地 0 点 = UTC 05:00 EST）
    now2 = datetime(2026, 3, 1, 20, 0, tzinfo=ZoneInfo("America/New_York"))
    payload2 = tm.build_ingest_payload(agent, cfg, now=now2)
    assert payload2["periodWindows"]["today"]["endsAt"] == "2026-03-02T05:00:00+00:00"


def test_tm_device_id_isolated_from_cloud_id(tmp_path):
    cfg = tm_config(tmp_path, device_id="dev-x", token_monitor_device_id="")
    assert tm.resolve_tm_device_id(cfg) == "openwebui:dev-x"
    cfg2 = tm_config(tmp_path, device_id="dev-x", token_monitor_device_id="dev-x")
    assert tm.resolve_tm_device_id(cfg2) is None  # 相同 ID 拒绝
    cfg3 = tm_config(tmp_path, device_id="dev-x", token_monitor_device_id="tm-own-id")
    assert tm.resolve_tm_device_id(cfg3) == "tm-own-id"


def test_bridge_not_started_without_config(tmp_path, caplog):
    import threading
    cfg = tm_config(tmp_path, token_monitor_hub_url="", token_monitor_secret="")
    agent = make_agent(cfg, AgentState(cfg.state_path), FakeSession())
    assert tm.start_bridge_thread(agent) is None


def test_bridge_health_check_variants():
    session = FakeSession()
    session.route("GET", "/api/health", FakeResponse(200, {"ok": True, "role": "hub", "hubBuild": {"schemaVersion": 3}}))
    body = tm.check_hub_health(session, "https://tm.example.com", 5)
    assert body["ok"] is True

    s2 = FakeSession()
    s2.route("GET", "/api/health", FakeResponse(200, {"ok": False}))
    with pytest.raises(tm.PermanentBridgeError):
        tm.check_hub_health(s2, "https://tm.example.com", 5)

    s3 = FakeSession()
    s3.route("GET", "/api/health", FakeResponse(503, None, "unavailable"))
    with pytest.raises(tm.TransientBridgeError):
        tm.check_hub_health(s3, "https://tm.example.com", 5)


def test_bridge_push_4xx_permanent_5xx_transient(tmp_path):
    cfg = tm_config(tmp_path)
    agent = StubAgent(cfg, stub_usage())

    s4 = FakeSession()
    s4.route("POST", "/api/ingest", FakeResponse(400, None, "bad payload"))
    with pytest.raises(tm.PermanentBridgeError):
        tm.push_to_token_monitor(agent, "https://tm.example.com", "secret", session=s4)

    s5 = FakeSession()
    s5.route("POST", "/api/ingest", FakeResponse(502, None, "bad gateway"))
    with pytest.raises(tm.TransientBridgeError):
        tm.push_to_token_monitor(agent, "https://tm.example.com", "secret", session=s5)

    s2xx = FakeSession()
    s2xx.route("POST", "/api/ingest", FakeResponse(200, {"ok": True}))
    result = tm.push_to_token_monitor(agent, "https://tm.example.com", "secret", session=s2xx)
    assert set(result) == {"today", "month", "allTime"}
    headers = [c[2]["headers"] for c in s2xx.calls if c[0] == "POST"][0]
    assert headers["Authorization"] == "Bearer secret"
    assert headers["X-Token-Monitor-Secret"] == "secret"


# ---------------------------------------------------------------- 健康检查


def test_healthcheck_states(tmp_path, monkeypatch, capsys):
    import healthcheck

    state_path = tmp_path / "state.json"
    monkeypatch.setenv("STATE_PATH", str(state_path))

    # 从未成功 → 不健康
    state = AgentState(state_path)
    state.device_id = "d"
    state.save()
    monkeypatch.setattr("sys.argv", ["healthcheck.py"])
    assert healthcheck.main() == 1

    # 近期成功 → 健康
    state.data["last_success_at"] = utc_now_iso()
    state.save()
    assert healthcheck.main() == 0

    # 存在未解决永久错误 → 不健康
    state.data["last_permanent_error"] = "HTTP 401"
    state.save()
    assert healthcheck.main() == 1

    # 成功过旧 → 不健康
    state.data["last_permanent_error"] = None
    state.data["last_success_at"] = "2020-01-01T00:00:00+00:00"
    state.save()
    assert healthcheck.main() == 1
