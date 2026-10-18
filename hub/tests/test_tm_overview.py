"""云端用量面板扩展契约测试（/api/v1/tm/overview + /api/v1/tm/subscriptions）。

覆盖 tm_overview 在官方 stats 聚合之上叠加的面板字段：trend_models /
activity(hourly,daily+history 回填) / limits 拍平 / sessions 拍平 /
projects 规范化 / diagnostics / period_windows，以及 /tm 301 兼容跳转。
全部经 conftest 的真实 Node hub（官方聚合权威）端到端断言。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from conftest import (
    READ_KEY,
    TM_SECRET,
    make_cloud_app,
    official_payload,
    requires_node,
    widget_style_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


@requires_node
@pytest.mark.parametrize("moment, expected_today, expected_month", [
    ("2026-10-31T14:59:59.999Z", {"tokyo", "los-angeles", "legacy", "invalid-date"}, {"tokyo", "los-angeles", "legacy", "invalid-date"}),
    ("2026-10-31T15:00:00Z", {"los-angeles", "legacy", "invalid-date"}, {"los-angeles", "legacy", "invalid-date"}),
    ("2026-11-01T00:00:00Z", {"los-angeles", "invalid-date"}, {"los-angeles", "invalid-date"}),
    ("2026-11-01T07:00:00Z", {"invalid-date"}, {"invalid-date"}),
    ("2026-10-18T15:00:00Z", {"tokyo", "los-angeles", "invalid-date"}, {"tokyo", "los-angeles", "legacy", "invalid-date"}),
    ("2026-11-02T00:00:00Z", set(), set()),
])
def test_session_period_expiry_matches_real_upstream_aggregate(tmp_path, moment, expected_today, expected_month):
    """Raw device periods survive upstream expiry; Cloud must not revive them."""
    import json
    import subprocess
    from conftest import VENDOR
    from hub.db import Database
    from hub.tm_outbox import ensure_schema as ensure_outbox_schema
    from hub.tm_snapshots import ensure_schema
    from hub.tm_overview import build_overview

    def device(device_id, tokens, updated, windows=None):
        session = {"client": "codex", "sessionId": device_id, "totalTokens": tokens,
                   "models": {"model-a": tokens}}
        period = {"totalTokens": tokens, "models": {"model-a": tokens},
                  "sessions": {f"codex:{device_id}": session}}
        return {"deviceId": device_id, "updatedAt": updated,
                # Future receipts yield negative ageMs and still encode nowMs.
                "receivedAt": "2026-11-02T12:00:00Z", "periodWindows": windows,
                "today": period, "month": period, "allTime": period,
                "sessionDetailsOmitted": {"today": 2, "month": 3}}

    records = [
        device("tokyo", 11, "2026-10-01T00:00:00Z", {"timeZone": "Asia/Tokyo",
               "today": {"endsAt": "2026-11-01T00:00:00+09:00"},
               "month": {"endsAt": "2026-11-01T00:00:00+09:00"}}),
        device("los-angeles", 13, "2026-09-30T00:00:00Z", {"timeZone": "America/Los_Angeles",
               "today": {"endsAt": "2026-11-01T00:00:00-07:00"},
               "month": {"endsAt": "2026-11-01T00:00:00-07:00"}}),
        # Fresh receipt does not make an old updatedAt current. UTC date, not
        # the timestamp's textual local date or the dashboard zone, is used.
        device("legacy", 17, "2026-11-01T01:00:00+09:00"),
        device("invalid-date", 19, "invalid-date"),
    ]
    if not expected_today and not expected_month:
        records = [record for record in records if record["deviceId"] != "invalid-date"]
    result = subprocess.run([
        "node", "-e", "const {aggregateDevices}=require('./src/shared/usage');"
        "const input=JSON.parse(require('fs').readFileSync(0,'utf8'));"
        "console.log(JSON.stringify(aggregateDevices(input.devices,1,Date.parse(input.now))));",
    ], cwd=VENDOR, input=json.dumps({"devices": records, "now": moment}),
        check=True, capture_output=True, text=True)
    stats = json.loads(result.stdout)
    assert all(device["periods"]["today"]["sessions"] for device in stats["devices"])
    assert all(device["ageMs"] < 0 for device in stats["devices"])
    db = Database(tmp_path / "expiry.sqlite3")
    ensure_schema(db)
    ensure_outbox_schema(db)
    try:
        # Cloud's clock deliberately differs from the official aggregation.
        data = build_overview(db, stats, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
        for period, expected in (("today", expected_today), ("month", expected_month)):
            rows = data["sessions_by_period"][period]
            assert {row["deviceId"] for row in rows} == expected
            assert sum(row["tokens"] for row in rows) == stats["periods"][period]["totalTokens"]
            meta = data["sessions_meta_by_period"][period]
            assert meta["sessions_total"] == len(expected)
            assert meta["sessions_omitted_count"] == len(expected) * (2 if period == "today" else 3)
            assert meta["availability"] == ("partial" if expected else "unavailable")
        assert data["sessions"] == data["sessions_by_period"]["today"]
        assert data["sessions_by_period"]["allTime"] == []
        assert data["totals"]["allTime"]["totalTokens"] == sum(record["allTime"]["totalTokens"] for record in records)
    finally:
        db.close()


@requires_node
def test_model_throughput_survives_a_current_device_without_timing(tmp_path):
    """Upstream drops a period's whole modelThroughput once one current device
    lacks it; Cloud rebuilds it from the current devices that report timing and
    counts, per model, the devices that used it without timing."""
    import json
    import subprocess
    from conftest import VENDOR
    from hub.db import Database
    from hub.tm_outbox import ensure_schema as ensure_outbox_schema
    from hub.tm_snapshots import ensure_schema
    from hub.tm_overview import build_overview

    def period(models, timed=None):
        tokens = sum(models.values())
        data = {"totalTokens": tokens, "outputTokens": tokens, "models": models, "modelOutputs": dict(models)}
        if timed is not None:
            data.update({key: sum(item[key] for item in timed.values()) for key in
                         ("timedTokens", "timedOutputTokens", "timedDurationMs")})
            data["modelThroughput"] = timed
        return data

    widget = {"model-a": {"timedTokens": 900, "timedOutputTokens": 400, "timedDurationMs": 10_000}}
    stale = {"model-a": {"timedTokens": 300, "timedOutputTokens": 100, "timedDurationMs": 5_000}}
    records = [
        {"deviceId": "widget", "updatedAt": "2026-10-18T09:00:00Z", "receivedAt": "2026-10-18T09:00:00Z",
         "today": period({"model-a": 1000}, widget), "month": period({"model-a": 1000}, widget),
         "allTime": period({"model-a": 1000}, widget)},
        # An older headless agent reports no timing: unused today, model-a this
        # month and model-b only before it.
        {"deviceId": "agent", "updatedAt": "2026-10-18T09:30:00Z", "receivedAt": "2026-10-18T09:30:00Z",
         "today": period({}), "month": period({"model-a": 50}), "allTime": period({"model-a": 50, "model-b": 7})},
        # Last synced three days ago: its today has ended, its month has not.
        {"deviceId": "stale", "updatedAt": "2026-10-15T09:00:00Z", "receivedAt": "2026-10-15T09:00:00Z",
         "today": period({"model-a": 300}, stale), "month": period({"model-a": 300}, stale),
         "allTime": period({"model-a": 300}, stale)},
    ]
    result = subprocess.run([
        "node", "-e", "const {aggregateDevices}=require('./src/shared/usage');"
        "const input=JSON.parse(require('fs').readFileSync(0,'utf8'));"
        "console.log(JSON.stringify(aggregateDevices(input.devices,600000,Date.parse(input.now))));",
    ], cwd=VENDOR, input=json.dumps({"devices": records, "now": "2026-10-18T10:00:00Z"}),
        check=True, capture_output=True, text=True)
    stats = json.loads(result.stdout)
    for name in ("today", "month", "allTime"):
        assert "modelThroughput" not in stats["periods"][name]
    db = Database(tmp_path / "throughput.sqlite3")
    ensure_schema(db)
    ensure_outbox_schema(db)
    try:
        partial = build_overview(db, stats, now=datetime(2030, 1, 1, tzinfo=timezone.utc))["model_throughput_partial"]
        assert partial["today"] == {"models": widget, "missingDevices": {}}
        both = {key: widget["model-a"][key] + stale["model-a"][key] for key in widget["model-a"]}
        assert partial["month"] == {"models": {"model-a": both}, "missingDevices": {"model-a": 1}}
        assert partial["allTime"] == {"models": {"model-a": both}, "missingDevices": {"model-a": 1, "model-b": 1}}
    finally:
        db.close()

    complete = dict(stats, periods=dict(stats["periods"], today=dict(stats["periods"]["today"], modelThroughput=widget)))
    db = Database(tmp_path / "complete.sqlite3")
    ensure_schema(db)
    ensure_outbox_schema(db)
    try:
        assert "today" not in build_overview(db, complete)["model_throughput_partial"]
    finally:
        db.close()


@pytest.mark.parametrize("stamp_field", ["updatedAt", "generatedAt"])
def test_session_expiry_uses_stats_timestamp_when_age_is_unavailable(stamp_field):
    from hub.tm_overview import _session_period_details

    record = {"deviceId": "expired", "updatedAt": "2026-10-31T12:00:00Z",
              "receivedAt": "2026-11-01T00:01:00Z",
              "periods": {period: {"sessions": {"codex:old": {"tokens": 10}}}
                          for period in ("today", "month")}}
    stats = {stamp_field: "2026-11-01T00:00:00Z", "devices": [record]}
    for period in ("today", "month"):
        meta, rows = _session_period_details(stats, period)
        assert rows == []
        assert meta["availability"] == "unavailable"
        assert meta["sessions_total"] == 0
    # The same retained snapshot was valid immediately before its UTC boundary.
    stats[stamp_field] = "2026-10-31T23:59:59.999Z"
    assert len(_session_period_details(stats, "today")[1]) == 1


def test_session_expiry_fallback_matches_upstream_missing_and_invalid_dates():
    from hub.tm_overview import _session_period_expired

    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert _session_period_expired({"receivedAt": "2026-10-31T23:59:59Z"}, "today", now)
    assert not _session_period_expired({"updatedAt": "invalid", "receivedAt": "2026-10-31T23:59:59Z"}, "today", now)
    assert not _session_period_expired({}, "today", now)
    assert not _session_period_expired({"updatedAt": "2025-01-01"}, "allTime", now)
    for end in ("invalid", "1970-01-01T00:00:00Z"):
        assert _session_period_expired({"updatedAt": "2026-10-31T23:59:59Z",
            "periodWindows": {"today": {"endsAt": end}}}, "today", now)


def ingest(cloud, payload):
    resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
    assert resp.status_code == 200, resp.text[:300]
    return resp.json()


def overview(cloud):
    resp = cloud.get("/api/v1/tm/overview", headers=READ)
    assert resp.status_code == 200, resp.text[:300]
    return resp.json()


# ================================================================ 静态面板与兼容跳转


def test_overview_non_json_stats_yields_structured_502(cloud):
    """上游 200 但响应体非 JSON（网关错误页等）：与非 200 分支一致给 502，
    而不是 resp.json() 抛 ValueError 变裸 500。"""

    class TextResponse:
        status_code = 200
        text = "<html>gateway</html>"

        def json(self):
            raise ValueError("not json")

    class FakeCore:
        def request(self, *_args, **_kwargs):
            return TextResponse()

    original = cloud.app.state.tm_core
    cloud.app.state.tm_core = FakeCore()
    try:
        resp = cloud.get("/api/v1/tm/overview", headers=READ)
        assert resp.status_code == 502
    finally:
        cloud.app.state.tm_core = original


def test_tm_redirects_to_root(cloud):
    for path in ("/tm", "/tm/"):
        resp = cloud.get(path, follow_redirects=False)
        assert resp.status_code == 301
        assert resp.headers["location"] == "/"


def test_root_serves_panel_index(node_hub, tmp_path):
    (tmp_path / "index.html").write_text("<html>panel-marker</html>", encoding="utf-8")
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        resp = cloud.get("/")
        assert resp.status_code == 200
        assert "panel-marker" in resp.text
        # 静态资源挂载在同一目录
        (tmp_path / "tm.js").write_text("// panel", encoding="utf-8")
        assert cloud.get("/static/tm.js").status_code == 200


# ================================================================ 周期富字段透传


@requires_node
def test_period_rich_fields_passthrough(cloud):
    ingest(cloud, widget_style_payload("dev-rich"))
    today = overview(cloud)["totals"]["today"]
    assert today["cacheReadTokens"] == 986000
    assert today["clientCosts"] == {"claude": 3.8, "codex": 1.02}
    assert today["modelCacheReads"] == {"opus-4.5": 700000, "gpt-5.2": 286000}
    assert today["modelCacheWrites"] == {"opus-4.5": 80000, "gpt-5.2": 40000}
    assert today["clientModels"] == {"claude": {"opus-4.5": 1000000}, "codex": {"gpt-5.2": 846320}}
    assert today["clientModelCosts"] == {}  # 未上报时官方输出空表（不推导）


@requires_node
def test_period_client_model_costs_passthrough(cloud):
    pa = widget_style_payload("dev-cmc")
    pa["today"]["clientModelCosts"] = {"claude": {"opus-4.5": 3.0}, "codex": {"gpt-5.2": 1.82}}
    ingest(cloud, pa)
    today = overview(cloud)["totals"]["today"]
    assert today["clientModelCosts"] == {"claude": {"opus-4.5": 3.0}, "codex": {"gpt-5.2": 1.82}}


# ================================================================ trend_models / activity


@requires_node
def test_trend_models_merges_models_across_devices(cloud):
    pa = widget_style_payload("dev-a")
    ingest(cloud, pa)
    pb = widget_style_payload("dev-b", tz="Asia/Tokyo")
    pb["hostname"] = "ThinkPad"
    pb["today"]["models"] = {"gpt-5.2": 100, "sonnet-4": 50}
    pb["today"]["totalTokens"] = 150
    ingest(cloud, pb)

    day = pa["periodWindows"]["today"]["key"]
    data = overview(cloud)
    rows = {r["day"]: r for r in data["trend_models"]}
    assert day in rows
    assert rows[day]["total"] == 1846320 + 150
    assert rows[day]["models"] == {"opus-4.5": 1000000, "gpt-5.2": 846320 + 100, "sonnet-4": 50}
    # trend（纯总量）与 trend_models 同一天对齐
    trend = {r["day"]: r["total"] for r in data["trend"]}
    assert trend[day] == rows[day]["total"]


@requires_node
def test_hourly_activity_diff_buckets(cloud):
    assert overview(cloud)["activity"]["hourly"] == []  # 无数据为空数组

    pa = widget_style_payload("dev-h")
    # 钉在东京中午：墙钟靠近 15:00 UTC 时 now+6min 会跨过东京午夜，增量落到次日。
    noon = datetime.now(ZoneInfo("Asia/Tokyo")).replace(
        hour=12, minute=0, second=0, microsecond=0,
    )
    pa["updatedAt"] = noon.astimezone(timezone.utc).isoformat(
        timespec="milliseconds",
    ).replace("+00:00", "Z")
    ingest(cloud, pa)
    hourly = overview(cloud)["activity"]["hourly"]
    assert len(hourly) == 24
    assert [h["hour"] for h in hourly] == list(range(24))
    # 首次上报：差分 = 全量，落在某个 UTC 小时桶
    assert sum(h["total"] for h in hourly) == 1846320

    # 同一设备再次上报（下一桶模拟增量）：差分只计增量，负值钳 0。
    later = noon + timedelta(minutes=6)
    pa["updatedAt"] = later.astimezone(timezone.utc).isoformat(
        timespec="milliseconds",
    ).replace("+00:00", "Z")
    pa["today"]["totalTokens"] = 1846320 + 500
    ingest(cloud, pa)
    hourly = overview(cloud)["activity"]["hourly"]
    assert sum(h["total"] for h in hourly) == 1846320 + 500

    # 回退上报（总量变小）产生 0 增量而非负数
    pa["today"]["totalTokens"] = 100
    later2 = later + timedelta(minutes=6)
    pa["updatedAt"] = later2.astimezone(timezone.utc).isoformat(
        timespec="milliseconds",
    ).replace("+00:00", "Z")
    ingest(cloud, pa)
    hourly = overview(cloud)["activity"]["hourly"]
    assert sum(h["total"] for h in hourly) == 1846320 + 500


@requires_node
def test_daily_activity_history_backfill_snapshot_wins(cloud):
    pa = widget_style_payload("dev-hist")
    day = pa["periodWindows"]["today"]["key"]
    pa["history"] = {
        "daily": [
            {"date": "2026-06-01", "tokens": 777, "cost": 0.1},
            {"date": day, "tokens": 1, "cost": 0.0},  # 与快照同日：应被快照压制
        ]
    }
    ingest(cloud, pa)
    daily = {r["day"]: r["total"] for r in overview(cloud)["activity"]["daily"]}
    assert daily["2026-06-01"] == 777          # 快照缺失日由 history 回填
    assert daily[day] == 1846320               # 同一天快照优先，不被 history 覆盖


# ================================================================ limits / sessions / projects


def _with_limits(payload, provider, plan, pct, **extra):
    payload["limits"] = {
        "providers": [
            {
                "provider": provider,
                "planLabel": plan,
                "windows": [{"kind": "session", "label": "5h", "usedPercent": pct}],
                **extra,
            }
        ]
    }
    return payload


@requires_node
def test_limits_flattened_with_device_display(cloud):
    pa = _with_limits(widget_style_payload("dev-la"), "claude", "Max 5x", 42,
                      accountKey="k-claude", accountEmail="a@example.com")
    ingest(cloud, pa)
    pb = _with_limits(widget_style_payload("dev-lb"), "codex", "Pro", 10,
                      accountKey="k-codex")
    pb["hostname"] = "ThinkPad"
    ingest(cloud, pb)

    limits = overview(cloud)["limits"]
    by_provider = {l["provider"]: l for l in limits}
    assert set(by_provider) == {"claude", "codex"}
    anth = by_provider["claude"]
    assert anth["planLabel"] == "Max 5x"
    assert anth["device"] == "MacBook-Pro"
    assert anth["windows"][0]["usedPercent"] == 42
    assert by_provider["codex"]["device"] == "ThinkPad"


@requires_node
def test_limits_same_account_across_devices_deduped(cloud):
    """同一 provider+account 两台设备上报：官方聚合只保留一条（取较新）。"""
    pa = _with_limits(widget_style_payload("dev-dup-a"), "claude", "Max 5x", 40,
                      accountKey="same-key")
    ingest(cloud, pa)
    pb = _with_limits(widget_style_payload("dev-dup-b"), "claude", "Max 5x", 55,
                      accountKey="same-key")
    pb["hostname"] = "ThinkPad"
    ingest(cloud, pb)

    limits = [l for l in overview(cloud)["limits"] if l["provider"] == "claude"]
    assert len(limits) == 1
    assert limits[0]["device"] in {"MacBook-Pro", "ThinkPad"}


def _session(client, sid, tokens, **kw):
    return {
        "client": client,
        "sessionId": sid,
        "totalTokens": tokens,
        "costUsd": round(tokens / 10000, 4),
        "models": {"gpt-5.2": tokens},
        "startedAt": "2026-08-22T01:00:00.000Z",
        "lastUsedAt": "2026-08-22T02:00:00.000Z",
        **kw,
    }


@requires_node
def test_sessions_flattened_sorted_capped(cloud):
    pa = widget_style_payload("dev-sa")
    pa["projectsEnabled"] = True
    pa["today"]["sessions"] = {
        f"codex:s{i}": _session("codex", f"s{i}", i, projectLabel="cloud-monitor")
        for i in range(106)
    }
    pa["today"]["sessions"]["claude:big"] = _session(
        "claude", "big", 9999, projectLabel="web"
    )
    ingest(cloud, pa)
    pb = widget_style_payload("dev-sb")
    pb["hostname"] = "ThinkPad"
    pb["today"]["sessions"] = {"cursor:x1": _session("cursor", "x1", 500)}
    ingest(cloud, pb)

    data = overview(cloud)
    sessions = data["sessions"]
    assert len(sessions) == 100  # 107 条截到 100
    assert sessions[0]["client"] == "claude" and sessions[0]["sessionId"] == "big"
    assert sessions[0]["tokens"] == 9999
    assert sessions[0]["costUsd"] == 0.9999
    assert sessions[0]["models"] == {"gpt-5.2": 9999}
    assert sessions[0]["project"] == "web"
    assert sessions[0]["startedAt"] == "2026-08-22T01:00:00.000Z"
    assert sessions[0]["lastUsedAt"] == "2026-08-22T02:00:00.000Z"
    assert sessions[0]["device"] == "MacBook-Pro"
    assert [s["tokens"] for s in sessions] == sorted(
        [s["tokens"] for s in sessions], reverse=True
    )
    assert sessions[-1]["tokens"] >= 6  # 截断丢掉的是最小的
    assert any(s["device"] == "ThinkPad" and s["client"] == "cursor" for s in sessions)
    assert data["sessions_omitted"] is False


@requires_node
def test_sessions_omitted_flag(cloud):
    pa = widget_style_payload("dev-omit")
    pa["sessionDetailsOmitted"] = {"today": 7}
    ingest(cloud, pa)
    data = overview(cloud)
    assert data["sessions"] == []
    assert data["sessions_omitted"] is True


@requires_node
def test_projects_normalized_with_devices(cloud):
    pa = widget_style_payload("dev-pa")
    pa["projectsEnabled"] = True
    pa["allTime"]["projects"] = {
        "web": {"label": "web", "tokens": 100, "costUsd": 1.0, "clients": {"claude": 100}},
        "api": {"label": "api", "tokens": 50, "costUsd": 0.5, "clients": {"codex": 50}},
    }
    ingest(cloud, pa)
    pb = widget_style_payload("dev-pb")
    pb["hostname"] = "ThinkPad"
    pb["projectsEnabled"] = True
    pb["allTime"]["projects"] = {
        "web": {"label": "web", "tokens": 200, "costUsd": 2.0,
                "clients": {"claude": 150, "codex": 50}},
    }
    ingest(cloud, pb)

    projects = overview(cloud)["projects"]
    assert [p["label"] for p in projects] == ["web", "api"]  # tokens 降序
    web = projects[0]
    assert web["tokens"] == 300
    assert abs(web["costUsd"] - 3.0) < 1e-6
    assert web["clients"] == {"claude": 250, "codex": 50}
    assert web["devices"] == ["MacBook-Pro", "ThinkPad"]
    assert projects[1]["devices"] == ["MacBook-Pro"]


@requires_node
def test_projects_empty_when_absent(cloud):
    ingest(cloud, widget_style_payload("dev-np"))
    assert overview(cloud)["projects"] == []


@requires_node
def test_project_models_from_official_rollup(cloud):
    """v0.74 官方按会话汇总项目时带出按模型词元；旧版设备的项目只计入 tokens。"""
    current = widget_style_payload("dev-v074")
    current["projectsEnabled"] = True
    current["allTime"] = {
        "totalTokens": 1700,
        "clients": {"codex": 1200, "claude": 500},
        "sessions": {
            "codex:s-web": {"client": "codex", "sessionId": "s-web", "projectLabel": "web",
                            "totalTokens": 1000, "models": {"GPT-5.4": 600, "o3": 400}},
            # 模型合计超过会话总量：官方 addProjectModels 只分到会话的 500
            "claude:s-cap": {"client": "claude", "sessionId": "s-cap", "projectLabel": "web",
                             "totalTokens": 500, "models": {"opus-4.5": 800}},
            "codex:s-api": {"client": "codex", "sessionId": "s-api", "projectLabel": "api",
                            "totalTokens": 200},
        },
    }
    ingest(cloud, official_payload(current))
    legacy = widget_style_payload("dev-v073")
    legacy["hostname"] = "ThinkPad"
    legacy["projectsEnabled"] = True
    legacy["allTime"]["projects"] = {
        "web": {"label": "web", "tokens": 300, "costUsd": 0.1, "clients": {"codex": 300}},
    }
    ingest(cloud, legacy)

    projects = {p["label"]: p for p in overview(cloud)["projects"]}
    web = projects["web"]
    assert web["tokens"] == 1800
    assert web["models"] == {"gpt-5.4": 600, "o3": 400, "opus-4.5": 500}
    assert web["clients"] == {"codex": 1300, "claude": 500}
    assert sorted(web["devices"]) == ["MacBook-Pro", "ThinkPad"]
    assert projects["api"]["models"] == {}


@requires_node
def test_projects_by_period_follow_upstream_expiry(cloud):
    """今日、本月的项目由官方按会话汇总；今日窗口已结束的设备不计入今日。"""
    def session(client, sid, tokens, models):
        return {"client": client, "sessionId": sid, "projectLabel": "web",
                "totalTokens": tokens, "models": models}

    current = widget_style_payload("dev-proj-now")
    current["projectsEnabled"] = True
    current["today"]["sessions"] = {"codex:a1": session("codex", "a1", 300, {"gpt-5.4": 300})}
    current["month"]["sessions"] = {"codex:a2": session("codex", "a2", 900, {"gpt-5.4": 900})}
    ingest(cloud, current)
    ended = widget_style_payload("dev-proj-ended")
    ended["hostname"] = "ThinkPad"
    ended["projectsEnabled"] = True
    now = datetime.now(timezone.utc)
    ended["periodWindows"]["today"]["endsAt"] = (now - timedelta(hours=1)).isoformat()
    ended["periodWindows"]["month"]["endsAt"] = (now + timedelta(days=1)).isoformat()
    ended["today"]["sessions"] = {"claude:b1": session("claude", "b1", 100, {"opus-4.5": 100})}
    ended["month"]["sessions"] = {"claude:b2": session("claude", "b2", 400, {"o3": 400})}
    ingest(cloud, ended)

    data = overview(cloud)
    by_period = data["projects_by_period"]
    today = {p["label"]: p for p in by_period["today"]}["web"]
    assert (today["tokens"], today["models"], today["devices"]) == (300, {"gpt-5.4": 300}, ["MacBook-Pro"])
    month = {p["label"]: p for p in by_period["month"]}["web"]
    assert month["tokens"] == 1300
    assert month["models"] == {"gpt-5.4": 900, "o3": 400}
    assert month["clients"] == {"codex": 900, "claude": 400}
    assert sorted(month["devices"]) == ["MacBook-Pro", "ThinkPad"]
    assert by_period["allTime"] == data["projects"]
    assert data["projects_meta_by_period"] == {
        period: {"incomplete": False} for period in ("today", "month", "allTime")
    }


@requires_node
def test_projects_meta_marks_incomplete_breakdowns(cloud):
    """上游口径：今日、本月有设备省略了项目明细，或累计有设备关闭项目统计。"""
    omitted = widget_style_payload("dev-omitted")
    omitted["projectsEnabled"] = True
    omitted["periodProjectsOmitted"] = {"today": 2}
    ingest(cloud, omitted)
    ingest(cloud, widget_style_payload("dev-disabled"))  # projectsEnabled False，累计有用量
    assert overview(cloud)["projects_meta_by_period"] == {
        "today": {"incomplete": True}, "month": {"incomplete": False}, "allTime": {"incomplete": True},
    }


def test_project_models_keep_only_non_negative_integers():
    from hub.tm_overview import _collect_projects

    stats = {"periods": {"allTime": {"projects": {
        "web": {"label": "web", "tokens": 10, "models": {
            "kept": 7, "zero": 0, "negative": -1, "flag": True,
            "fraction": 1.5, "text": "7", "missing": None,
        }},
        "api": {"label": "api", "tokens": 5, "models": ["not", "a", "map"]},
    }}}}
    projects = {p["label"]: p for p in _collect_projects(stats)}
    assert projects["web"]["models"] == {"kept": 7, "zero": 0}
    assert projects["api"]["models"] == {}


# ================================================================ diagnostics / period_windows


@requires_node
def test_diagnostics_and_period_windows(cloud):
    pa = widget_style_payload("dev-diag")
    pa["clientStatus"] = {"claude": "active", "codex": "waiting"}
    pa["clientHealth"] = {
        "clients": {
            "claude": {
                "source": {"checkedCount": 1, "detectedCount": 1},
                "collection": {"state": "direct"},
                "data": {"liveTokens": 123},
            }
        }
    }
    ingest(cloud, pa)
    pb = widget_style_payload("dev-plain")  # 无诊断字段
    pb["hostname"] = "ThinkPad"
    ingest(cloud, pb)

    data = overview(cloud)
    diag = {d["deviceId"]: d for d in data["diagnostics"]}
    assert diag["dev-diag"]["clientStatus"] == {"claude": "active", "codex": "waiting"}
    assert diag["dev-diag"]["clientHealth"]["clients"]["claude"]["overall"] == "healthy"
    assert diag["dev-diag"]["wslStatus"] is None
    # 缺失诊断字段的设备输出 null（前端自动隐藏对应行）
    assert diag["dev-plain"]["clientHealth"] is None
    assert diag["dev-plain"]["clientStatus"] is None

    windows = data["period_windows"]
    assert windows["timeZone"] == "Asia/Tokyo"
    assert windows["today"]["key"] == pa["periodWindows"]["today"]["key"]


@requires_node
def test_period_windows_none_without_devices(cloud):
    assert overview(cloud)["period_windows"] is None


# ================================================================ 订阅只读端点


@requires_node
def test_subscriptions_read_endpoint(cloud):
    # 空状态：官方文档 updatedAt 为空串 → updated_at None
    empty = cloud.get("/api/v1/tm/subscriptions", headers=READ)
    assert empty.status_code == 200
    assert empty.json() == {"subscriptions": [], "updated_at": None}

    put = cloud.put("/api/subscriptions", headers=HEADERS, json={
        "subscriptions": [
            {"id": "s1", "provider": "anthropic", "kind": "subscription",
             "planName": "Max 5x", "amountMinor": 20000, "currency": "USD",
             "interval": "month", "startDate": "2026-01-01"}
        ],
    })
    assert put.status_code == 200

    resp = cloud.get("/api/v1/tm/subscriptions", headers=READ)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["subscriptions"]) == 1
    assert body["subscriptions"][0]["planName"] == "Max 5x"
    assert body["updated_at"]  # 官方 updatedAt 透传


@requires_node
def test_subscriptions_read_auth_isolation(cloud):
    assert cloud.get("/api/v1/tm/subscriptions").status_code == 401
    # TM 写入密钥不能读面板端点
    assert cloud.get("/api/v1/tm/subscriptions", headers=HEADERS).status_code == 401


# ================================================================ 上游降级


def test_overview_502_when_core_down(tmp_path):
    cloud = make_cloud_app(tmp_path, "http://127.0.0.1:9")  # 无监听端口
    with cloud:
        assert cloud.get("/api/v1/tm/overview", headers=READ).status_code == 502
        assert cloud.get("/api/v1/tm/subscriptions", headers=READ).status_code == 502


def test_session_period_details_keep_periods_unknowns_and_privacy():
    from hub.tm_overview import _collect_sessions, _session_period_details

    today = {"client": "codex", "sessionId": "same", "totalTokens": 17,
             "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 2,
             "cacheWriteTokens": 0, "reasoningTokens": 3, "messageCount": 2,
             "models": {"model-a": 17}, "modelCosts": {"model-a": 0.2},
             "providers": {"openai": 17}, "contextTokens": 12, "contextWindow": 200,
             "timedOutputTokens": 5, "timedDurationMs": 1000,
             "title": "accepted canonical title", "messages": ["private prompt"], "toolEvents": ["private tool"]}
    stats = {"devices": [{"deviceId": "a", "periods": {
        "today": {"sessions": {"codex:same": today}},
        "month": {"sessions": {"codex:same": {**today, "totalTokens": 170}}},
        "allTime": {"sessions": {"codex:same": today}},
    }}]}
    meta, rows = _session_period_details(stats, "today")
    assert meta["availability"] == "available"
    assert rows[0]["inputTokens"] == 10
    assert rows[0]["reasoningTokens"] == 3
    assert rows[0]["modelCosts"] == {"model-a": 0.2}
    assert rows[0]["providers"] == {"openai": 17}
    assert rows[0]["costUsd"] is None
    assert rows[0]["title"] == "accepted canonical title"
    assert not any(field in rows[0] for field in ("messages", "toolEvents"))
    assert _session_period_details(stats, "month")[1][0]["tokens"] == 170
    all_meta, all_rows = _session_period_details(stats, "allTime")
    assert all_meta["reason"] == "not-synced" and all_rows == []
    assert all_meta["call_details_available"] is False
    _, missing = _collect_sessions({"devices": [{"deviceId": "x", "periods": {
        "today": {"sessions": {"codex:missing": {"client": "codex", "sessionId": "missing"}}}
    }}]})
    assert "inputTokens" not in missing[0]
    assert "reasoningTokens" not in missing[0]
    assert missing[0]["costUsd"] is None


def test_session_period_details_reports_both_upstream_and_dashboard_omission():
    from hub.tm_overview import _session_period_details

    stats = {"sessionDetailsOmitted": {"month": 7}, "devices": [{"deviceId": "a", "periods": {
        "month": {"sessions": {f"codex:{i}": {"client": "codex", "sessionId": str(i), "totalTokens": i} for i in range(105)}}
    }}]}
    meta, rows = _session_period_details(stats, "month")
    assert len(rows) == 100
    assert meta["availability"] == "partial"
    assert meta["sessions_total"] == 105 and meta["sessions_omitted_count"] == 7
    assert meta["dashboard_omitted_count"] == 5
    assert _session_period_details(stats, "today")[0]["availability"] == "unavailable"


@requires_node
def test_overview_exposes_synced_session_details_in_their_actual_period(cloud):
    payload = widget_style_payload("period-detail")
    row = _session("codex", "one", 170)
    row.update(inputTokens=100, outputTokens=50, cacheReadTokens=20, cacheWriteTokens=0,
               reasoningTokens=15, messageCount=3, modelCosts={"gpt-5.2": 0.02},
               contextTokens=120, contextWindow=200000, timedOutputTokens=50, timedDurationMs=2500)
    payload["today"]["sessions"] = {"codex:one": row}
    payload["month"]["sessions"] = {"codex:one": {**row, "totalTokens": 340, "inputTokens": 200, "outputTokens": 100, "cacheReadTokens": 40}}
    ingest(cloud, payload)
    data = overview(cloud)
    today = data["sessions_by_period"]["today"][0]
    month = data["sessions_by_period"]["month"][0]
    assert today == data["sessions"][0]
    assert today["tokens"] == 170 and month["tokens"] == 340
    assert today["inputTokens"] == 100 and month["inputTokens"] == 200
    assert today["reasoningTokens"] == 15 and today["messageCount"] == 3
    assert today["contextWindow"] == 200000 and today["timedDurationMs"] == 2500
    assert today["modelCosts"] == {"gpt-5.2": 0.02}
    assert data["sessions_by_period"]["allTime"] == []
    assert data["sessions_meta_by_period"]["allTime"]["reason"] == "not-synced"


@requires_node
def test_overview_marks_zeros_inserted_by_real_upstream_normalization(cloud):
    import json
    import subprocess
    from conftest import VENDOR

    # This source deliberately lacks output/cache/reasoning/count/cost fields.
    result = subprocess.run([
        "node", "-e", "const {normalizePeriod}=require('./src/shared/usage');"
        "console.log(JSON.stringify(normalizePeriod({sessions:{x:{client:'codex',"
        "sessionId:'x',totalTokens:10,inputTokens:10,models:{m:10}}}})));",
    ], cwd=VENDOR, check=True, capture_output=True, text=True)
    normalized = json.loads(result.stdout)
    source = normalized["sessions"]["codex:x"]
    assert source["outputTokens"] == source["cacheReadTokens"] == source["reasoningTokens"] == 0
    assert source["messageCount"] == source["costUsd"] == 0
    payload = widget_style_payload("normalized-zero-source")
    payload["today"] = normalized
    ingest(cloud, payload)
    data = overview(cloud)
    row = data["sessions"][0]
    assert row["zeroValuesUnconfirmed"] is True
    assert row["inputTokens"] == 10
    assert row["outputTokens"] == row["cacheReadTokens"] == row["reasoningTokens"] == 0
    assert row["messageCount"] == row["costUsd"] == 0
    assert data["sessions_by_period"]["today"][0]["zeroValuesUnconfirmed"] is True


@requires_node
def test_canonical_session_titles_follow_real_consent_and_revocation(tmp_path, monkeypatch):
    import copy
    import json
    from conftest import NodeHub

    canonical = "已同意上报的会话标题" + "题" * 180
    private_text = "PRIVATE-MESSAGE-TOOL-OR-COMPAT-TEXT"
    payload = widget_style_payload("consented-title-device")
    payload["sessionTitleSyncGeneration"] = 1
    row = _session("codex", "consented-title", 10)
    row.update(title=canonical, preview=private_text, firstUserMessage=private_text,
               sessionTitle=private_text, session_title=private_text, customTitle=private_text,
               name=private_text, aiTitle=private_text, messages=[private_text],
               toolEvents=[private_text], toolResults=[private_text])
    payload["today"]["sessions"] = {"codex:consented-title": row}
    payload["month"]["sessions"] = {"codex:consented-title": row}
    policy_path = "/api/sync/titles/consented-title-device"

    def read_session(client):
        data = overview(client)
        assert private_text not in json.dumps(data, ensure_ascii=False)
        return data, data["sessions"][0]

    monkeypatch.delenv("TOKEN_MONITOR_SYNC_SESSION_TITLES", raising=False)
    disabled = NodeHub(tmp_path / "disabled-node.json")
    try:
        with make_cloud_app(tmp_path / "disabled-cloud", disabled.url) as client:
            ingest(client, payload)
            assert "title" not in read_session(client)[1]
            denied = client.put(policy_path, headers=HEADERS, json={"enabled": True})
            assert denied.status_code == 403
    finally:
        disabled.stop()

    # Only this isolated child process receives the opt-in environment. Neither
    # the user's settings nor the normal test/server configuration is changed.
    monkeypatch.setenv("TOKEN_MONITOR_SYNC_SESSION_TITLES", "true")
    enabled = NodeHub(tmp_path / "enabled-node.json")
    try:
        with make_cloud_app(tmp_path / "enabled-cloud", enabled.url) as client:
            # Keep the real default 30-second overview cache. Revocation below
            # must invalidate it through the Cloud proxy, with no sleeps or clears.
            assert client.app.state.settings.overview_cache_seconds == 30
            ingest(client, payload)
            assert "title" not in read_session(client)[1]  # Server opt-in alone is insufficient.
            consent = client.put(policy_path, headers=HEADERS, json={"enabled": True})
            assert consent.status_code == 200, consent.text
            generation = consent.json()["generation"]
            wrong_generation = copy.deepcopy(payload)
            wrong_generation["sessionTitleSyncGeneration"] = generation + 1
            ingest(client, wrong_generation)
            assert "title" not in read_session(client)[1]
            agreed = copy.deepcopy(payload)
            agreed["sessionTitleSyncGeneration"] = generation
            agreed["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat(timespec="milliseconds")
            ingest(client, agreed)
            accepted, accepted_row = read_session(client)
            assert accepted_row["title"] == canonical[:160]
            assert accepted["sessions_by_period"]["month"][0]["title"] == canonical[:160]
            # Prime the retained overview again, then revoke via its real route.
            assert read_session(client)[1]["title"] == canonical[:160]
            assert client.get("/api/v1/tm/overview", headers=HEADERS).status_code == 401
            assert client.put(policy_path, headers=READ, json={"enabled": False}).status_code == 401
            revoked = client.put(policy_path, headers=HEADERS, json={"enabled": False})
            assert revoked.status_code == 200, revoked.text
            revoked_overview, revoked_row = read_session(client)
            assert "title" not in revoked_row
            assert "title" not in revoked_overview["sessions_by_period"]["month"][0]
            # A late upload with the revoked generation cannot resurrect text.
            late_upload = copy.deepcopy(agreed)
            late_upload["updatedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat(timespec="milliseconds")
            ingest(client, late_upload)
            assert "title" not in read_session(client)[1]
    finally:
        enabled.stop()
