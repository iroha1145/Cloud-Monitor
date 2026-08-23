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
from fastapi import APIRouter, HTTPException, Query, Request

from .auth import require_access_token
from .config import Settings
from .db import Database
from .tm_proxy import TmCore
from .tm_snapshots import HARD_RETENTION_DAYS, query_daily_archive, trend_by_day, valid_day_key

log = logging.getLogger("tm-overview")

TREND_DAYS = 30
ACTIVITY_DAILY_DAYS = 90
FINE_ACTIVITY_DAYS = 7
SESSIONS_LIMIT = 100
GAP_BUCKETS = 2  # 相邻桶间隔超过 2 个槽位视为采样缺口（低覆盖）
LATE_START_GRACE_MINUTES = 10  # 本地日开始后 10 分钟内的首桶不算晚启动


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


def _now_for_dashboard(dashboard_tz: str, now: Any = None):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(dashboard_tz)
    if now is None:
        return datetime.now(tz), tz
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(tz), tz


def _parse_bucket_dt(stamp: Any):
    from datetime import datetime

    if not stamp:
        return None
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None


def _fmt_z(dt) -> Optional[str]:
    if dt is None:
        return None
    from datetime import timezone

    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _first_bucket_late(stamp: str, local_day: str, tz_name: str) -> bool:
    """首桶是否明显晚于设备本地日开始。

    每个设备天然有第一个桶，不得因此把所有有数据的情况标成 low-coverage。
    仅当首桶明显晚于本地日 00:00（超过 10 分钟宽限）才算晚启动。
    """
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo

    moment = _parse_bucket_dt(stamp)
    if moment is None or not valid_day_key(local_day):
        return True
    tz = None
    if tz_name:
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = None
    if tz is None:
        tz = timezone.utc
    local = moment.astimezone(tz)
    day_start = datetime.fromisoformat(local_day).replace(tzinfo=tz)
    return local > day_start + timedelta(minutes=LATE_START_GRACE_MINUTES)


def _bucket_gap_slots(prev: str | None, curr: str) -> int:
    """相邻桶之间隔了多少个 5 分钟槽位（时间差/5min，同桶为 0）。"""
    a, b = _parse_bucket_dt(prev), _parse_bucket_dt(curr)
    if a is None or b is None:
        return GAP_BUCKETS + 1
    return max(int((b - a).total_seconds() // 300), 0)


def _deltas_for_device(rows: list[dict]) -> list[dict]:
    """同一设备按时间排序的相邻差分。换本地日视为新周期，不记累计回退。"""
    out: list[dict] = []
    prev_total: int | None = None
    prev_bucket: str | None = None
    prev_day: str | None = None
    for row in rows:
        value = _int(row["today_total"])
        stamp = str(row["bucket_start"])
        local_day = str(row["local_day"])
        tz_name = str(row.get("device_time_zone") or "")
        if prev_total is None or prev_day != local_day:
            out.append(
                {
                    "device_id": row["device_id"],
                    "bucket_start": stamp,
                    "local_day": local_day,
                    "delta": value,
                    "first": True,
                    "gap": False,
                    "late_start": _first_bucket_late(stamp, local_day, tz_name),
                    "reset": False,
                }
            )
        else:
            gap = _bucket_gap_slots(prev_bucket, stamp) > GAP_BUCKETS
            delta = value - prev_total
            reset = delta < 0
            out.append(
                {
                    "device_id": row["device_id"],
                    "bucket_start": stamp,
                    "local_day": local_day,
                    "delta": 0 if reset else delta,
                    "first": False,
                    "gap": gap or reset,
                    "late_start": False,
                    "reset": reset,
                }
            )
        prev_total = value
        prev_bucket = stamp
        prev_day = local_day
    return out


def _coverage_for_device(deltas: list[dict]) -> dict:
    stamps = []
    gap_count = 0
    reset_count = 0
    late = False
    for entry in deltas:
        moment = _parse_bucket_dt(entry["bucket_start"])
        if moment is not None:
            stamps.append(moment)
        if entry.get("reset"):
            reset_count += 1
        elif entry.get("gap") and not entry.get("first"):
            gap_count += 1
        if entry.get("late_start"):
            late = True
    observed = len(stamps)
    expected = (
        int((max(stamps) - min(stamps)).total_seconds() // 300) + 1 if stamps else 0
    )
    return {
        "device_id": deltas[0]["device_id"] if deltas else None,
        "first_sample_at": _fmt_z(min(stamps)) if stamps else None,
        "last_sample_at": _fmt_z(max(stamps)) if stamps else None,
        "expected_buckets": expected,
        "observed_buckets": observed,
        "gap_count": gap_count,
        "reset_count": reset_count,
        "late_start": late,
    }


def _load_fine_buckets(db: Database, start_day: str, end_day: str) -> list[dict]:
    return db.fetchall(
        """
        SELECT device_id, local_day, bucket_start, today_total, device_time_zone,
               server_received_at, id
        FROM tm_snapshot_buckets
        WHERE local_day >= ? AND local_day <= ?
        ORDER BY device_id, local_day ASC, bucket_start ASC, server_received_at ASC, id ASC
        """,
        (start_day, end_day),
    )


def _attribution_mode(device_diags: list[dict], expected_total: int, observed_total: int) -> str:
    if expected_total == 0 and observed_total == 0:
        return "none"
    if any(d.get("reset_count") for d in device_diags):
        return "delta-with-reset"
    if any(d.get("late_start") or d.get("gap_count") for d in device_diags):
        return "delta-low-coverage"
    return "delta"


def activity_report(db: Database, dashboard_tz, now: Any = None) -> dict:
    """活动口径：hourly 只收仪表盘今日；daily 近 7 天 5 分钟桶 + 更早日锚点。

    coverage 按设备求和：expected_total = Σ expected_device，
    observed_total = Σ observed_device，coverage_percent 钳制 0–100。
    """
    from collections import defaultdict
    from datetime import timedelta

    local_now, tz = _now_for_dashboard(dashboard_tz, now)
    today_key = local_now.date().isoformat()
    start_day = (local_now.date() - timedelta(days=FINE_ACTIVITY_DAYS + 1)).isoformat()
    end_day = (local_now.date() + timedelta(days=1)).isoformat()
    rows = _load_fine_buckets(db, start_day, end_day)

    by_device: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_device[row["device_id"]].append(row)

    hourly: dict[int, int] = {h: 0 for h in range(24)}
    has_today_hourly = False
    fine_daily: dict[str, int] = {}
    device_diags: list[dict] = []
    expected_total = 0
    observed_total = 0
    first_samples: list = []
    last_samples: list = []

    for device_rows in by_device.values():
        deltas = _deltas_for_device(device_rows)
        if not deltas:
            continue
        latest_day = max(r["local_day"] for r in device_rows)
        latest_deltas = [d for d in deltas if d["local_day"] == latest_day]
        cov = _coverage_for_device(latest_deltas)
        device_diags.append(
            {
                "device_id": cov["device_id"],
                "first_sample_at": cov["first_sample_at"],
                "last_sample_at": cov["last_sample_at"],
                "expected_buckets": cov["expected_buckets"],
                "observed_buckets": cov["observed_buckets"],
                "gap_count": cov["gap_count"],
                "reset_count": cov["reset_count"],
            }
        )
        # 诊断字段挂在内部对象上供 attribution 使用
        device_diags[-1]["late_start"] = cov["late_start"]
        expected_total += cov["expected_buckets"]
        observed_total += cov["observed_buckets"]
        if cov["first_sample_at"]:
            first_samples.append(cov["first_sample_at"])
        if cov["last_sample_at"]:
            last_samples.append(cov["last_sample_at"])

        for entry in deltas:
            moment = _parse_bucket_dt(entry["bucket_start"])
            if moment is None:
                continue
            local = moment.astimezone(tz)
            dash_day = local.date().isoformat()
            # 5 分钟差分按仪表盘日入 daily（含跨日溢出的次日）；
            # 只有转换后日期 == 仪表盘今日 才进 24 小时图。
            fine_daily[dash_day] = fine_daily.get(dash_day, 0) + entry["delta"]
            if dash_day == today_key:
                hourly[local.hour] = hourly.get(local.hour, 0) + entry["delta"]
                has_today_hourly = True

    if expected_total:
        coverage_percent = round(observed_total / expected_total * 100, 1)
        coverage_percent = max(0.0, min(100.0, coverage_percent))
    else:
        coverage_percent = 0.0

    mode = _attribution_mode(device_diags, expected_total, observed_total)
    public_diags = [
        {k: v for k, v in d.items() if k != "late_start"} for d in device_diags
    ]

    # 近 7 个仪表盘日（含今日）用 5 分钟差分；更早才用设备本地日锚点。
    # 归档不得覆盖 rollup 窗口，否则「设备本地昨日」会与滚进仪表盘今日的
    # 同一笔 5 分钟用量双计。
    rollup_start = local_now.date() - timedelta(days=FINE_ACTIVITY_DAYS - 1)
    archive_from = (local_now.date() - timedelta(days=ACTIVITY_DAILY_DAYS)).isoformat()
    archive_to = (rollup_start - timedelta(days=1)).isoformat()
    archive = query_daily_archive(
        db, from_day=archive_from, to_day=archive_to, limit=ACTIVITY_DAILY_DAYS
    )
    daily_map: dict[str, int] = {
        item["day"]: int(item["tokens"] or 0)
        for item in archive["items"]
        if item["day"] not in fine_daily
    }
    for day, total in fine_daily.items():
        daily_map[day] = total

    hourly_buckets = (
        [{"hour": h, "total": hourly.get(h, 0)} for h in range(24)]
        if has_today_hourly
        else []
    )
    if not by_device and not archive["items"]:
        return {
            "time_zone": str(tz),
            "hourly": [],
            "hourly_day": today_key,
            "hourly_today": {
                "day": today_key,
                "time_zone": str(tz),
                "buckets": [],
            },
            "daily": [],
            "coverage": {
                "first_sample_at": None,
                "last_sample_at": None,
                "expected_buckets": 0,
                "observed_buckets": 0,
                "coverage_percent": 0.0,
                "attribution_mode": "none",
                "devices": [],
                "gap_count": 0,
                "reset_count": 0,
            },
        }

    return {
        "time_zone": str(tz),
        "hourly": hourly_buckets,
        "hourly_day": today_key,
        "hourly_today": {
            "day": today_key,
            "time_zone": str(tz),
            "buckets": hourly_buckets,
        },
        "daily": [
            {"day": d, "total": daily_map[d]}
            for d in sorted(daily_map)[-ACTIVITY_DAILY_DAYS:]
        ],
        "coverage": {
            "first_sample_at": min(first_samples) if first_samples else None,
            "last_sample_at": max(last_samples) if last_samples else None,
            "expected_buckets": expected_total,
            "observed_buckets": observed_total,
            "coverage_percent": coverage_percent,
            "attribution_mode": mode,
            "devices": public_diags,
            "gap_count": sum(d.get("gap_count") or 0 for d in public_diags),
            "reset_count": sum(d.get("reset_count") or 0 for d in public_diags),
        },
    }


def hourly_activity(db: Database, dashboard_tz: str = "UTC", now: Any = None) -> list[dict]:
    """兼容旧调用：返回 24 小时桶。"""
    return activity_report(db, dashboard_tz, now=now)["hourly"]


def daily_activity(
    db: Database, history: Optional[dict], days: int = ACTIVITY_DAILY_DAYS,
    *, dashboard_tz: str = "UTC", now: Any = None, sqlite_daily: Optional[list] = None,
) -> list[dict]:
    """近 N 天每日总量：与 history/daily 共用日归档查询核心。

    近 7 天用 5 分钟桶按仪表盘日聚合；更早用每日锚点（设备本地日）。
    官方 History 不可用时 SQLite 仍给出多日序列。同日快照优先于 history。
    """
    if sqlite_daily is None:
        sqlite_daily = activity_report(db, dashboard_tz, now=now)["daily"]
    totals = {row["day"]: row["total"] for row in sqlite_daily}
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
    provider_status_enabled: bool = True,
    now: Any = None,
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
        activity = activity_report(db, dashboard_time_zone, now=now)
        daily = daily_activity(
            db,
            history,
            dashboard_tz=dashboard_time_zone,
            now=now,
            sqlite_daily=activity.get("daily"),
        )
        activity["daily"] = daily
    except Exception as exc:  # noqa: BLE001 — SQLite 异常不伪装成空数据
        log.warning("activity 计算失败: %s", exc)
        partial_errors.append({"code": "activity_unavailable", "source": "sqlite"})
        activity = {
            "time_zone": dashboard_time_zone,
            "hourly": [],
            "hourly_day": None,
            "hourly_today": {"day": None, "time_zone": dashboard_time_zone, "buckets": []},
            "daily": [],
            "coverage": None,
        }

    windows_by_device = {
        str(d.get("deviceId")): d.get("periodWindows")
        for d in stats.get("devices") or []
        if isinstance(d.get("periodWindows"), dict) and d.get("periodWindows")
    }
    dashboard_period = _dashboard_period(dashboard_time_zone, now=now)

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
            "provider_status": bool(provider_status_enabled),
            "history_daily": True,
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


def _dashboard_period(dashboard_tz: str, now: Any = None) -> dict:
    """仪表盘时区的当前 today/month 窗口（供前端展示口径）。"""
    now, tz = _now_for_dashboard(dashboard_tz, now)
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
            provider_status_enabled=settings.provider_status_enabled,
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

    @router.get("/api/v1/tm/provider-status")
    async def tm_provider_status(request: Request) -> dict:
        """Cloud 扩展：官方状态页。ACCESS_TOKEN only；禁止 TOKEN_MONITOR_SECRET。"""
        require_access_token(request, settings)
        _require_core()
        if not settings.provider_status_enabled:
            raise HTTPException(status_code=404, detail="provider-status 未启用")

        from .tm_provider_status import discover_providers

        core = _core(request)
        stats, stats_error = _fetch(core, "/api/stats")
        subs, subs_error = _fetch(core, "/api/subscriptions")
        observed = discover_providers(stats, subs)
        service = request.app.state.provider_status
        client = request.app.state.http_async
        envelope = await service.snapshot(client=client, observed=observed)
        if stats_error:
            envelope["partial"] = True
            envelope["errors"].append(
                {"error_code": "stats_unavailable", "source": "tm-core"}
            )
        if subs_error:
            envelope["partial"] = True
            envelope["errors"].append(
                {"error_code": "subscriptions_unavailable", "source": "tm-core"}
            )
        # 忽略任何客户端传入的 url 参数：allowlist 之外永不请求
        if request.query_params.get("url"):
            log.warning("provider-status ignored client url parameter")
        return envelope

    @router.get("/api/v1/tm/history/daily")
    def tm_history_daily(
        request: Request,
        cursor: Optional[str] = None,
        limit: int = 30,
        device_id: Optional[str] = None,
        from_day: Optional[str] = Query(default=None, alias="from"),
        to: Optional[str] = None,
    ) -> dict:
        """370 天设备本地日归档分页。不塞进每 5 分钟刷新的 Overview。"""
        require_access_token(request, settings)
        _require_core()
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="limit 必须是整数") from None
        if limit < 1 or limit > 90:
            raise HTTPException(status_code=400, detail="limit 范围 1-90")
        if cursor is not None and valid_day_key(cursor) is None:
            raise HTTPException(status_code=400, detail="cursor 必须是 YYYY-MM-DD")
        if from_day is not None and valid_day_key(from_day) is None:
            raise HTTPException(status_code=400, detail="from 必须是 YYYY-MM-DD")
        if to is not None and valid_day_key(to) is None:
            raise HTTPException(status_code=400, detail="to 必须是 YYYY-MM-DD")
        page = query_daily_archive(
            db,
            cursor=cursor,
            limit=limit,
            device_id=device_id,
            from_day=from_day,
            to_day=to,
        )
        return {
            "schema_version": 1,
            "day_basis": "device-local",
            "dashboard_time_zone": settings.dashboard_time_zone,
            "retention_days": HARD_RETENTION_DAYS,
            "mixed_time_zones": page["mixed_time_zones"],
            "device_time_zone": page["device_time_zone"],
            "items": page["items"],
            "next_cursor": page["next_cursor"],
            "has_more": page["has_more"],
            "partial": page["partial"],
            "partial_errors": page["partial_errors"],
        }

    return router
