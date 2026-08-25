"""云端用量面板扩展契约测试（/api/v1/tm/overview + /api/v1/tm/subscriptions）。

覆盖 tm_overview 在官方 stats 聚合之上叠加的面板字段：trend_models /
activity(hourly,daily+history 回填) / limits 拍平 / sessions 拍平 /
projects 规范化 / diagnostics / period_windows，以及 /tm 301 兼容跳转。
全部经 conftest 的真实 Node hub（官方聚合权威）端到端断言。
"""

from __future__ import annotations

from conftest import (
    READ_KEY,
    TM_SECRET,
    make_cloud_app,
    requires_node,
    widget_style_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}
READ = {"Authorization": f"Bearer {READ_KEY}"}


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
    ingest(cloud, pa)
    hourly = overview(cloud)["activity"]["hourly"]
    assert len(hourly) == 24
    assert [h["hour"] for h in hourly] == list(range(24))
    # 首次上报：差分 = 全量，落在某个 UTC 小时桶
    assert sum(h["total"] for h in hourly) == 1846320

    # 同一设备再次上报（下一桶模拟增量）：差分只计增量，负值钳 0
    pa["updatedAt"] = None  # 占位，下面覆盖
    import datetime as _dt

    later = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(minutes=6)
    pa["updatedAt"] = later.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    pa["today"]["totalTokens"] = 1846320 + 500
    ingest(cloud, pa)
    hourly = overview(cloud)["activity"]["hourly"]
    assert sum(h["total"] for h in hourly) == 1846320 + 500

    # 回退上报（总量变小）产生 0 增量而非负数
    pa["today"]["totalTokens"] = 100
    later2 = later + _dt.timedelta(minutes=6)
    pa["updatedAt"] = later2.isoformat(timespec="milliseconds").replace("+00:00", "Z")
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
