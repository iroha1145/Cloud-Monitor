"""云端用量面板数据组装（GET /api/v1/tm/overview + /api/v1/tm/subscriptions）。

协议权威仍是 tm-core（vendored 官方 Node hub）：本模块只读取官方
/api/stats、/api/devices、/api/history、/api/subscriptions 的聚合结果，
叠加 SQLite 5 分钟桶快照（tm_snapshot_buckets，官方不提供的长期时间
序列），不重造官方聚合逻辑。

面板扩展契约（相对官方 stats 的新增字段）：
- trend_models: 近 30 天 [{day, total, models}]——每设备每本地日最后一个
  桶的 today_total / models_json 跨设备合并。
- activity.hourly: 最新本地日的 24 小时桶 [{hour, total}]——当天桶的
  today_total 相邻差分（负值钳 0）跨设备求和，小时取桶的 UTC 小时；
  无数据返回 []。
- activity.daily: 近 90 天 [{day, total}]——快照趋势扩窗，缺失日期用官方
  /api/history 的 daily 回填（同一天快照优先）。
- limits: 官方聚合 limits.providers 透传，每条附 device 显示名
  （sourceDeviceId → hostname）。
- sessions / sessions_omitted: 各设备 today 周期 sessions 拍平（键
  client:sessionId 跨设备去重留大者），按 tokens 降序截 100；
  sessions_omitted 取自官方聚合 sessionDetailsOmitted.today。
- projects: 官方聚合 periods.allTime.projects 规范化输出，附 devices 归属。
- diagnostics: 每设备 clientHealth/clientStatus/wslStatus 透传（官方 stats
  devices 原生携带，缺失为 None，前端自动隐藏对应行）。
- period_windows: （deprecated，保留兼容）最新设备的 periodWindows 透传。
- period_windows_by_device / dashboard_period: 每设备窗口 + 仪表盘时区窗口。
- activity（v2 口径，P0-3）:
  * 每台设备独立取其最新有效本地日（不取全表最大 local_day）；
  * 每设备相邻快照差分（累计回退视为缺口），桶起点换算到
    DASHBOARD_TIME_ZONE 的小时——东京/洛杉矶设备同处一条全局时间轴；
  * coverage: first/last_sample_at、expected/observed_buckets、
    coverage_percent、attribution_mode（首次接入/断线缺口→低覆盖标记，
    不伪装成精确小时数据）；
  * activity.daily 采用【仪表盘日】（写入契约 docs/TM_OVERVIEW_CONTRACT.md，
    与小时口径一致；设备本地日仍在 trend/trend_models 使用）。
- sessions（P1-1）: 跨设备主键 deviceId:client:sessionId（不同设备同
  client:sessionId 均保留，不再互相删除），附 sessions_total/returned/
  omitted_count/session_details_incomplete。
- overview v2（P1-4）: overview_schema_version/features/partial/partial_errors
  /dashboard_time_zone；辅助来源失败标记 partial + 稳定错误码，不伪装成空。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

from .auth import require_access_token
from .config import Settings
from .db import Database
from .tm_proxy import TmCore
from .tm_snapshots import trend_by_day

log = logging.getLogger("tm-overview")

TREND_DAYS = 30
ACTIVITY_DAILY_DAYS = 90
SESSIONS_LIMIT = 100
GAP_BUCKETS = 2  # 相邻桶间隔超过 2 个槽位视为采样缺口（低覆盖）


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return max(0.0, float(value or 0.0))
    except (TypeError, ValueError):
        return 0.0


def _device_display(device: dict) -> str:
    return str(device.get("hostname") or "") or str(device.get("deviceId") or "")[:8]


# ---------------------------------------------------------------- 快照时间序列


def trend_models_by_day(db: Database, days: int = TREND_DAYS) -> list[dict]:
    """每设备每本地日最后一个桶，按天合并 today_total 与 models_json。

    日期范围在窗口函数之前收敛（local_day >= 下界），不加载 370 天全量
    后再在 Python 切 30 天。
    """
    from datetime import datetime, timedelta, timezone

    day_floor = (datetime.now(timezone.utc) - timedelta(days=days + 1)).date().isoformat()
    rows = db.fetchall(
        """
        SELECT local_day, today_total, models_json FROM (
            SELECT local_day, today_total, models_json,
                   ROW_NUMBER() OVER (
                       PARTITION BY device_id, local_day
                       ORDER BY bucket_start DESC, server_received_at DESC, id DESC
                   ) AS rn
            FROM tm_snapshot_buckets
            WHERE local_day >= ?
        ) WHERE rn = 1 ORDER BY local_day
        """,
        (day_floor,),
    )
    totals: dict[str, int] = {}
    models_by_day: dict[str, dict[str, int]] = {}
    for row in rows:
        day = row["local_day"]
        totals[day] = totals.get(day, 0) + _int(row["today_total"])
        try:
            models = json.loads(row["models_json"] or "{}")
        except ValueError:
            models = {}
        if not isinstance(models, dict):
            models = {}
        bucket = models_by_day.setdefault(day, {})
        for model, tokens in models.items():
            model = str(model)
            bucket[model] = bucket.get(model, 0) + _int(tokens)
    days_sorted = sorted(totals)[-days:]
    return [
        {"day": d, "total": totals[d], "models": models_by_day.get(d, {})}
        for d in days_sorted
    ]


def _device_deltas(db: Database) -> list[dict]:
    """每设备最新本地日的相邻桶差分：[{device_id, bucket_start, delta, gap}]。

    - 每台设备独立选择其最新有效 local_day（不取全表最大）；
    - 累计值回退/重置（delta<0）视为缺口，丢弃该差分并重置基线；
    - 日内首桶计入总量但标记 first=True（首次接入/断线后的累计量），
      供覆盖率口径标注低覆盖。
    """
    devices = db.fetchall(
        "SELECT device_id, MAX(local_day) AS day FROM tm_snapshot_buckets"
        " GROUP BY device_id"
    )
    out: list[dict] = []
    for row in devices:
        buckets = db.fetchall(
            """
            SELECT bucket_start, today_total FROM tm_snapshot_buckets
            WHERE device_id = ? AND local_day = ?
            ORDER BY bucket_start ASC, server_received_at ASC, id ASC
            """,
            (row["device_id"], row["day"]),
        )
        prev_total: int | None = None
        prev_bucket: str | None = None
        for i, bucket in enumerate(buckets):
            value = _int(bucket["today_total"])
            stamp = str(bucket["bucket_start"])
            if prev_total is None:
                out.append(
                    {"device_id": row["device_id"], "bucket_start": stamp,
                     "delta": value, "first": True, "gap": True}
                )
            else:
                gap = _bucket_gap_slots(prev_bucket, stamp) > GAP_BUCKETS
                delta = value - prev_total
                if delta < 0:  # 累计回退/重置：计 0 并标记缺口（旧契约：负值钳 0）
                    out.append(
                        {"device_id": row["device_id"], "bucket_start": stamp,
                         "delta": 0, "first": False, "gap": True}
                    )
                else:
                    out.append(
                        {"device_id": row["device_id"], "bucket_start": stamp,
                         "delta": delta, "first": False, "gap": gap}
                    )
            prev_total = value
            prev_bucket = stamp
    return out


def _bucket_gap_slots(prev: str | None, curr: str) -> int:
    """相邻桶之间隔了多少个 5 分钟槽位（时间差/5min，同桶为 0）。"""
    from datetime import datetime, timezone

    def parse(stamp: str | None):
        if not stamp:
            return None
        try:
            return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None

    a, b = parse(prev), parse(curr)
    if a is None or b is None:
        return GAP_BUCKETS + 1
    return max(int((b - a).total_seconds() // 300), 0)


def activity_report(db: Database, dashboard_tz) -> dict:
    """P0-3 统一活动口径：hourly（仪表盘时区小时）+ daily（仪表盘日）。"""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(dashboard_tz)
    deltas = _device_deltas(db)
    hourly: dict[int, int] = {}
    daily: dict[str, int] = {}
    stamps: list[datetime] = []
    observed = 0
    low_coverage = False
    for entry in deltas:
        try:
            moment = datetime.fromisoformat(entry["bucket_start"].replace("Z", "+00:00"))
        except ValueError:
            continue
        stamps.append(moment)
        observed += 1
        if entry["gap"] or entry["first"]:
            low_coverage = True
        local = moment.astimezone(tz)
        hourly[local.hour] = hourly.get(local.hour, 0) + entry["delta"]
        day = local.date().isoformat()
        daily[day] = daily.get(day, 0) + entry["delta"]

    first_sample = min(stamps).isoformat().replace("+00:00", "Z") if stamps else None
    last_sample = max(stamps).isoformat().replace("+00:00", "Z") if stamps else None
    if stamps:
        span_slots = int((max(stamps) - min(stamps)).total_seconds() // 300) + 1
    else:
        span_slots = 0
    expected = span_slots  # 每设备差分窗口的理想桶数总和的近似下界
    coverage = round(observed / expected * 100, 1) if expected else 0.0
    if not deltas:  # 无数据保持旧契约（空数组，前端据此隐藏图表）
        return {
            "time_zone": str(tz), "hourly": [], "daily": [],
            "coverage": {
                "first_sample_at": None, "last_sample_at": None,
                "expected_buckets": 0, "observed_buckets": 0,
                "coverage_percent": 0.0, "attribution_mode": "none",
            },
        }
    return {
        "time_zone": str(tz),
        "hourly": [{"hour": h, "total": hourly.get(h, 0)} for h in range(24)],
        "daily": [
            {"day": d, "total": daily[d]} for d in sorted(daily)[-ACTIVITY_DAILY_DAYS:]
        ],
        "coverage": {
            "first_sample_at": first_sample,
            "last_sample_at": last_sample,
            "expected_buckets": expected,
            "observed_buckets": observed,
            "coverage_percent": coverage,
            "attribution_mode": (
                "delta-low-coverage" if low_coverage else "delta"
            ),
        },
    }


def hourly_activity(db: Database, dashboard_tz: str = "UTC") -> list[dict]:
    """兼容旧调用：返回 24 小时桶。"""
    return activity_report(db, dashboard_tz)["hourly"]


def daily_activity(
    db: Database, history: Optional[dict], days: int = ACTIVITY_DAILY_DAYS,
    *, dashboard_tz: str = "UTC",
) -> list[dict]:
    """近 N 天每日总量【仪表盘日口径】：快照差分聚合为主，缺失日用官方
    history.daily 回填（同一天快照优先）。"""
    totals = {row["day"]: row["total"] for row in activity_report(db, dashboard_tz)["daily"]}
    if isinstance(history, dict):
        daily = history.get("daily")
        if isinstance(daily, list):
            for entry in daily:
                if not isinstance(entry, dict):
                    continue
                day = str(entry.get("date") or entry.get("day") or "")[:10]
                if not day:
                    continue
                totals.setdefault(day, _int(entry.get("tokens") or entry.get("totalTokens")))
    days_sorted = sorted(totals)[-days:]
    return [{"day": d, "total": totals[d]} for d in days_sorted]


# ---------------------------------------------------------------- 官方聚合整形


def _collect_limits(stats: dict) -> list[dict]:
    """官方聚合 limits.providers 透传，按 sourceDeviceId 附设备显示名。"""
    display = {str(d.get("deviceId")): _device_display(d) for d in stats.get("devices") or []}
    limits = stats.get("limits")
    providers = limits.get("providers") if isinstance(limits, dict) else None
    out: list[dict] = []
    for entry in providers or []:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        item["device"] = display.get(str(entry.get("sourceDeviceId") or ""), "")
        out.append(item)
    return out


def _collect_sessions(stats: dict) -> tuple[dict, list[dict]]:
    """各设备 today 周期 sessions 拍平。

    跨设备主键 deviceId:client:sessionId——不同设备出现相同 client:sessionId
    时两条都保留（不互相删除）；仅在存在官方稳定跨设备标识且内容一致时才
    会附 duplicate_group（当前官方无此标识，恒不附）。
    """
    by_key: dict[str, dict] = {}
    for device in stats.get("devices") or []:
        periods = device.get("periods") or {}
        today = periods.get("today") or {}
        sessions = today.get("sessions")
        if not isinstance(sessions, dict):
            continue
        display = _device_display(device)
        for key, value in sessions.items():
            if not isinstance(value, dict):
                continue
            client = str(value.get("client") or str(key).partition(":")[0])
            session_id = str(value.get("sessionId") or str(key).partition(":")[2])
            tokens = _int(value.get("totalTokens") or value.get("tokens"))
            models = value.get("models")
            item = {
                "client": client,
                "sessionId": session_id,
                "tokens": tokens,
                "costUsd": _float(value.get("costUsd") or value.get("cost")),
                "models": models if isinstance(models, dict) else {},
                "project": value.get("projectLabel") or value.get("project"),
                "startedAt": value.get("startedAt"),
                "lastUsedAt": value.get("lastUsedAt"),
                "device": display,
            }
            item["deviceId"] = device.get("deviceId")
            item["key"] = f"{device.get('deviceId')}:{client}:{session_id}"
            by_key[item["key"]] = item
    all_sessions = sorted(by_key.values(), key=lambda s: s["tokens"], reverse=True)
    omitted_counts = stats.get("sessionDetailsOmitted")
    omitted_count = (
        int(omitted_counts.get("today") or 0)
        if isinstance(omitted_counts, dict)
        else 0
    )
    meta = {
        "sessions_total": len(all_sessions),
        "sessions_returned": min(len(all_sessions), SESSIONS_LIMIT),
        "sessions_omitted_count": omitted_count,
        "session_details_incomplete": omitted_count > 0,
    }
    return meta, all_sessions[:SESSIONS_LIMIT]


def _collect_projects(stats: dict) -> list[dict]:
    """官方聚合 allTime.projects 规范化；devices 归属从各设备同期 projects 反查。"""
    periods = stats.get("periods") or {}
    all_time = periods.get("allTime") or {}
    projects = all_time.get("projects")
    if not isinstance(projects, dict):
        return []
    out: dict[str, dict] = {}
    for key, value in projects.items():
        if not isinstance(value, dict):
            continue
        clients = value.get("clients")
        out[str(key)] = {
            "label": str(value.get("label") or key),
            "tokens": _int(value.get("tokens") or value.get("totalTokens")),
            "costUsd": _float(value.get("costUsd") or value.get("cost")),
            "clients": {
                str(c): _int(t)
                for c, t in (clients.items() if isinstance(clients, dict) else [])
            },
            "devices": [],
        }
    for device in stats.get("devices") or []:
        dev_projects = ((device.get("periods") or {}).get("allTime") or {}).get("projects")
        if not isinstance(dev_projects, dict):
            continue
        display = _device_display(device)
        for key in dev_projects:
            bucket = out.get(str(key))
            if bucket is not None and display not in bucket["devices"]:
                bucket["devices"].append(display)
    return sorted(out.values(), key=lambda p: p["tokens"], reverse=True)


def _collect_diagnostics(stats: dict) -> list[dict]:
    """每设备诊断字段透传（官方 stats devices 原生携带，缺失为 None）。"""
    return [
        {
            "deviceId": device.get("deviceId"),
            "hostname": device.get("hostname"),
            "clientHealth": device.get("clientHealth"),
            "clientStatus": device.get("clientStatus"),
            "wslStatus": device.get("wslStatus"),
        }
        for device in stats.get("devices") or []
    ]


def _latest_period_windows(stats: dict) -> Optional[dict]:
    """最近上报设备的 periodWindows 原样透传（无则 None）。"""
    devices = sorted(
        (d for d in stats.get("devices") or [] if isinstance(d, dict)),
        key=lambda d: str(d.get("updatedAt") or d.get("receivedAt") or ""),
        reverse=True,
    )
    for device in devices:
        windows = device.get("periodWindows")
        if isinstance(windows, dict) and windows:
            return windows
    return None


# ---------------------------------------------------------------- 组装


def build_overview(
    db: Database,
    stats: dict,
    *,
    history: Optional[dict] = None,
    raw_devices: Optional[list] = None,
    dashboard_time_zone: str = "UTC",
) -> dict:
    """网页面板数据：官方 stats 透传 + 快照时间序列 + 面板扩展字段。"""
    badges: dict[str, dict] = {}
    for record in raw_devices or []:
        if not isinstance(record, dict):
            continue
        entry: dict[str, bool] = {}
        if "projectsEnabled" in record:
            entry["projectsEnabled"] = record.get("projectsEnabled") is not False
        if "historyAvailable" in record:
            entry["historyAvailable"] = record.get("historyAvailable") is True
        if entry:
            badges[str(record.get("deviceId"))] = entry

    devices = []
    for device in stats.get("devices") or []:
        periods = device.get("periods") or {}
        item = {
            "deviceId": device.get("deviceId"),
            "hostname": device.get("hostname"),
            "platform": device.get("platform"),
            "osName": device.get("osName"),
            "osVersion": device.get("osVersion"),
            "agentVersion": device.get("agentVersion"),
            "agentRuntime": device.get("agentRuntime"),
            "receivedAt": device.get("receivedAt"),
            "updatedAt": device.get("updatedAt"),
            "stale": device.get("stale"),
            "syncUploadIntervalMs": device.get("syncUploadIntervalMs"),
            "trackedClients": device.get("trackedClients"),
            "today": periods.get("today"),
            "month": periods.get("month"),
            "allTime": periods.get("allTime"),
            "limits": device.get("limits"),
        }
        item.update(badges.get(str(device.get("deviceId")), {}))
        devices.append(item)

    sessions_meta, sessions = _collect_sessions(stats)

    # v2 扩展：活动口径 / 每设备窗口 / 降级信息（P0-3 / P1-4）
    partial_errors: list[dict] = []
    try:
        from zoneinfo import ZoneInfo

        activity = activity_report(db, dashboard_time_zone)
        daily = daily_activity(db, history, dashboard_tz=dashboard_time_zone)
        activity["daily"] = daily
    except Exception as exc:  # noqa: BLE001 — SQLite 异常不伪装成空数据
        log.warning("activity 计算失败: %s", exc)
        partial_errors.append({"code": "activity_unavailable", "source": "sqlite"})
        activity = {"time_zone": dashboard_time_zone, "hourly": [], "daily": [],
                    "coverage": None}

    windows_by_device = {
        str(d.get("deviceId")): d.get("periodWindows")
        for d in stats.get("devices") or []
        if isinstance(d.get("periodWindows"), dict) and d.get("periodWindows")
    }
    dashboard_period = _dashboard_period(dashboard_time_zone)

    from .tm_outbox import snapshot_health

    overview = {
        "overview_schema_version": 2,
        "generated_at": stats.get("updatedAt") or stats.get("generatedAt"),
        **snapshot_health(db),
        "staleAfterMs": stats.get("staleAfterMs"),
        "dashboard_time_zone": dashboard_time_zone,
        "features": {
            "trend_models": True,
            "activity_hourly": True,
            "subscriptions": True,
        },
        "partial": bool(partial_errors),
        "partial_errors": partial_errors,
        "totals": stats.get("periods"),
        "devices": devices,
        "trend": trend_by_day(db),
        "trend_models": trend_models_by_day(db),
        "activity": activity,
        "period_windows": _latest_period_windows(stats),  # deprecated
        "period_windows_by_device": windows_by_device,
        "dashboard_period": dashboard_period,
        "limits": _collect_limits(stats),
        "sessions": sessions,
        "sessions_omitted": sessions_meta["session_details_incomplete"],  # deprecated
        "sessions_meta": sessions_meta,
        "projects": _collect_projects(stats),
        "diagnostics": _collect_diagnostics(stats),
    }
    if history is None:
        overview["partial"] = True
        overview["partial_errors"].append({"code": "history_unavailable", "source": "tm-core"})
    return overview


def _dashboard_period(dashboard_tz: str) -> dict:
    """仪表盘时区的当前 today/month 窗口（供前端展示口径）。"""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(dashboard_tz)
    now = datetime.now(tz)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if now.month == 12:
        next_month = today_start.replace(year=now.year + 1, month=1)
    else:
        next_month = today_start.replace(month=now.month + 1)

    def utc(dt) -> str:
        return dt.astimezone(tz).astimezone(
            __import__("datetime").timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    return {
        "time_zone": dashboard_tz,
        "today": {"key": today_start.date().isoformat(), "endsAt": utc(today_start)},
        "month": {
            "key": today_start.strftime("%Y-%m"),
            "endsAt": utc(next_month),
        },
    }


def build_tm_overview_router(settings: Settings, db: Database) -> APIRouter:
    router = APIRouter()

    def _core(request: Request) -> TmCore:
        return request.app.state.tm_core

    def _require_core() -> None:
        if not settings.tm_ingest_secret:
            raise HTTPException(status_code=404, detail="未启用 token-monitor 接入")

    def _fetch(core: TmCore, path: str) -> tuple[Optional[dict], Optional[str]]:
        """辅助上游读取：失败返回 (None, 稳定错误码)，不伪装成空。"""
        from .tm_proxy import UpstreamUnavailable

        try:
            resp = core.request("GET", path)
        except (httpx.HTTPError, UpstreamUnavailable) as exc:
            log.warning("tm-core %s 读取失败: %s", path, exc)
            return None, "upstream_unavailable"
        if resp.status_code != 200:
            return None, f"upstream_status_{resp.status_code}"
        try:
            data = resp.json()
        except ValueError:
            return None, "upstream_invalid_json"
        if not isinstance(data, dict):
            return None, "upstream_invalid_shape"
        return data, None

    @router.get("/api/v1/tm/overview")
    def tm_overview(request: Request) -> dict:
        require_access_token(request, settings)
        _require_core()
        core = _core(request)
        from .tm_proxy import UpstreamUnavailable

        try:
            resp = core.request("GET", "/api/stats")
        except (httpx.HTTPError, UpstreamUnavailable) as exc:
            raise HTTPException(status_code=502, detail="tm-core 聚合不可用") from exc
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="tm-core 聚合不可用")
        stats = resp.json()
        history, history_error = _fetch(core, "/api/history")
        raw, devices_error = _fetch(core, "/api/devices")
        raw_devices = raw.get("devices") if isinstance(raw, dict) else None
        overview = build_overview(
            db,
            stats,
            history=history,
            raw_devices=raw_devices,
            dashboard_time_zone=settings.dashboard_time_zone,
        )
        if history_error:
            overview["partial"] = True
            overview["partial_errors"].append(
                {"code": "history_unavailable", "source": "tm-core", "reason": history_error}
            )
        if devices_error:
            overview["partial"] = True
            overview["partial_errors"].append(
                {"code": "devices_badges_unavailable", "source": "tm-core", "reason": devices_error}
            )
        return overview

    @router.get("/api/v1/tm/subscriptions")
    def tm_subscriptions_read(request: Request) -> dict:
        """面板只读订阅清单：服务端持 TM 密钥向 tm-core 取数，ACCESS_TOKEN 鉴权。"""
        require_access_token(request, settings)
        _require_core()
        data, error = _fetch(_core(request), "/api/subscriptions")
        if data is None:
            raise HTTPException(status_code=502, detail="tm-core 订阅数据不可用")
        subscriptions = data.get("subscriptions")
        return {
            "subscriptions": subscriptions if isinstance(subscriptions, list) else [],
            "updated_at": data.get("updatedAt") or None,
        }

    return router
