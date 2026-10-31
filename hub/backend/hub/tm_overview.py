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
- sessions / sessions_omitted: 各设备 today 周期 sessions 拍平，按 tokens
  降序截 100；sessions_omitted 保留原上游省略标记以兼容旧界面。
- sessions_by_period / sessions_meta_by_period: 独立今日、本月明细及缺失说明；
  allTime 不同步会话明细，始终空列表并标注 not-synced。
- projects: 官方聚合 periods.allTime.projects 规范化输出（含按客户端、按模型
  的词元），附 devices 归属。
- projects_by_period / projects_meta_by_period: 今日、本月、累计各一份同样形状
  的项目列表（今日、本月只算未过期设备）及上游口径的不完整标记。
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

import asyncio
import json
import logging
import math
import time as _time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from itertools import groupby
from threading import Lock
from typing import Any, Optional
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from .auth import AccessBinding, CodedHTTPException, resolve_access_binding
from .config import Settings
from .db import Database
from .tm_outbox import snapshot_health
from .tm_provider_status import discover_providers
from .tm_proxy import TmCore, UpstreamUnavailable
from .tm_snapshots import (
    BUCKET_MS,
    HARD_RETENTION_DAYS,
    _parse_iso as _parse_bucket_dt,
    _safe_float as _float,
    _safe_int as _int,
    _zone,
    query_daily_archive,
    summarize_trend,
    trend_last_rows,
    utc_z,
)
from .tm_validate import valid_day_key

log = logging.getLogger("tm-overview")

TREND_DAYS = 30
ACTIVITY_DAILY_DAYS = 90
FINE_ACTIVITY_DAYS = 7
SESSIONS_LIMIT = 100
GAP_BUCKETS = 2  # 相邻桶间隔超过 2 个槽位视为采样缺口（低覆盖）
LATE_START_GRACE_MINUTES = 10  # 本地日开始后 10 分钟内的首桶不算晚启动
OVERVIEW_REFRESH_TIMEOUT_SECONDS = 20.0


def _device_display(device: dict) -> str:
    return str(device.get("hostname") or "") or str(device.get("deviceId") or "")[:8]


# ---------------------------------------------------------------- 快照时间序列


def summarize_trend_models(last_rows: list[dict]) -> list[dict]:
    """trend_last_rows 的结果按日合并 today_total 与 models_json，按日期升序返回。"""
    totals: dict[str, int] = {}
    models_by_day: dict[str, dict[str, int]] = {}
    for row in last_rows:
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
    days_sorted = sorted(totals)
    return [
        {"day": d, "total": totals[d], "models": models_by_day.get(d, {})}
        for d in days_sorted
    ]


def _trend_details(entry: dict) -> dict:
    """保留同一日记录的费用与组成；字段缺失不补零，也不跨来源拼接。"""
    details: dict[str, Any] = {}
    for key in (
        "outputTokens", "cacheReadTokens", "cacheWriteTokens", "unclassifiedTokens"
    ):
        value = entry.get(key)
        if key in entry and value is None:
            details[key] = None
        elif type(value) is int and value >= 0:
            details[key] = value
        elif type(value) is float and math.isfinite(value) and value >= 0 and value.is_integer():
            details[key] = int(value)
    for key in ("tokenComponentsAvailable", "componentsPartial"):
        if type(entry.get(key)) is bool:
            details[key] = entry[key]
    cost_key = "costUsd" if "costUsd" in entry else "cost"
    cost = entry.get(cost_key)
    if type(cost) in (int, float) and math.isfinite(cost):
        details["costUsd"] = cost
    return details


def _history_trend_row(entry: dict) -> Optional[dict]:
    """把官方 /api/history daily 行收成趋势行，保留当天缓存与费用。"""
    if not isinstance(entry, dict):
        return None
    day = str(entry.get("date") or entry.get("day") or "")[:10]
    if not valid_day_key(day):
        return None
    models: dict[str, int] = {}
    per = entry.get("perModel")
    if isinstance(per, dict):
        for name, value in per.items():
            if isinstance(value, dict):
                models[str(name)] = _int(value.get("tokens") or value.get("totalTokens"))
            else:
                models[str(name)] = _int(value)
    details = _trend_details(entry)
    if entry.get("tokenComponentsAvailable") is not True:
        # Official history aggregation fills absent component counters with
        # zeros. Without an exact-components marker those zeros have no field
        # provenance; positive counts remain useful as recognized partial data.
        # SQLite rows bypass this fallback and keep their recorded-zero rules.
        for key in ("outputTokens", "cacheReadTokens", "cacheWriteTokens"):
            if details.get(key) == 0:
                details[key] = None
        if any(key in details for key in (
            "outputTokens", "cacheReadTokens", "cacheWriteTokens", "unclassifiedTokens"
        )):
            details["componentsPartial"] = True
    return {
        "day": day,
        "total": _int(entry.get("tokens") or entry.get("totalTokens")),
        "models": models,
        **details,
    }


def merge_trend_with_history(
    sqlite_rows: list[dict],
    history: Optional[dict],
    *,
    days: int = TREND_DAYS,
    with_models: bool = False,
) -> list[dict]:
    """官方 history.daily 回填 SQLite 没有的日期；同一天以快照为准。"""
    by_day: dict[str, dict] = {}
    if isinstance(history, dict):
        daily = history.get("daily")
        if isinstance(daily, list):
            for entry in daily:
                row = _history_trend_row(entry)
                if not row:
                    continue
                if not with_models:
                    row.pop("models", None)
                by_day[row["day"]] = row
    for row in sqlite_rows or []:
        day = str((row or {}).get("day") or "")[:10]
        if not day:
            continue
        if with_models:
            models = row.get("models") if isinstance(row.get("models"), dict) else {}
            by_day[day] = {
                "day": day,
                "total": _int(row.get("total")),
                "models": dict(models),
                **_trend_details(row),
            }
        else:
            by_day[day] = {
                "day": day, "total": _int(row.get("total")), **_trend_details(row)
            }
    days_sorted = sorted(by_day)[-days:]
    return [by_day[d] for d in days_sorted]


def _now_for_dashboard(dashboard_tz: str, now: Any = None):

    tz = ZoneInfo(dashboard_tz)
    if now is None:
        return datetime.now(tz), tz
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(tz), tz


def _first_bucket_late(stamp: str, local_day: str, tz_name: str) -> bool:
    """首桶是否明显晚于设备本地日开始。

    每个设备天然有第一个桶，不得因此把所有有数据的情况标成 low-coverage。
    仅当首桶明显晚于本地日 00:00（超过 10 分钟宽限）才算晚启动。
    """

    moment = _parse_bucket_dt(stamp)
    if moment is None or not valid_day_key(local_day):
        return True
    tz = _zone(tz_name) or timezone.utc
    local = moment.astimezone(tz)
    day_start = datetime.fromisoformat(local_day).replace(tzinfo=tz)
    return local > day_start + timedelta(minutes=LATE_START_GRACE_MINUTES)


def _bucket_gap_slots(prev: str | None, curr: str) -> int:
    """相邻桶之间隔了多少个 5 分钟槽位（时间差/5min，同桶为 0）。"""
    a, b = _parse_bucket_dt(prev), _parse_bucket_dt(curr)
    if a is None or b is None:
        return GAP_BUCKETS + 1
    return max(int((b - a).total_seconds() // (BUCKET_MS // 1000)), 0)


def _deltas_for_device(
    rows: list[dict], *, expected_interval_ms: int = BUCKET_MS
) -> list[dict]:
    """同一设备按时间排序的相邻差分。换本地日视为新周期，不记累计回退。"""
    out: list[dict] = []
    expected_slots = max(
        1,
        round(
            max(int(expected_interval_ms or 0), BUCKET_MS)
            / BUCKET_MS
        ),
    )
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
            gap_slots = _bucket_gap_slots(prev_bucket, stamp)
            gap = gap_slots > max(GAP_BUCKETS, expected_slots * 2)
            reset = value < prev_total
            # 本地日内的第二行起，SQL 窗口给出的此前最大值必然非空（today_total NOT NULL）
            delta = max(0, value - int(row["prev_day_max"]))
            out.append(
                {
                    "device_id": row["device_id"],
                    "bucket_start": stamp,
                    "local_day": local_day,
                    "delta": delta,
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


def _coverage_for_device(
    deltas: list[dict], *, expected_interval_ms: int = BUCKET_MS
) -> dict:
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
    normalized_interval_ms = max(
        int(expected_interval_ms or 0), BUCKET_MS
    )
    sample_seconds = normalized_interval_ms / 1000
    expected = (
        int((max(stamps) - min(stamps)).total_seconds() // sample_seconds) + 1
        if stamps
        else 0
    )
    return {
        "device_id": deltas[0]["device_id"] if deltas else None,
        "first_sample_at": utc_z(min(stamps)) if stamps else None,
        "last_sample_at": utc_z(max(stamps)) if stamps else None,
        "expected_buckets": expected,
        "observed_buckets": observed,
        "gap_count": gap_count,
        "reset_count": reset_count,
        "late_start": late,
        "expected_interval_ms": normalized_interval_ms,
    }


def _load_fine_buckets(db: Database, start_day: str, end_day: str) -> list[dict]:
    # H-6：差分在 SQL 用 LAG/窗口算出；只取组装需要的瘦列，避免物化整行快照。
    return db.fetchall(
        """
        SELECT device_id, local_day, bucket_start, today_total, device_time_zone,
               prev_day_max
        FROM (
            SELECT device_id, local_day, bucket_start, today_total, device_time_zone,
                   MAX(today_total) OVER (
                       PARTITION BY device_id, local_day
                       ORDER BY bucket_start, server_received_at, id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ) AS prev_day_max
            FROM tm_snapshot_buckets
            WHERE local_day >= ? AND local_day <= ?
        )
        ORDER BY device_id, local_day ASC, bucket_start ASC
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


def activity_report(
    db: Database,
    dashboard_tz,
    now: Any = None,
    *,
    sync_intervals: Optional[dict[str, int]] = None,
) -> dict:
    """活动口径：hourly 只收仪表盘今日；daily 近 7 天 5 分钟桶 + 更早日锚点。

    coverage 按设备求和：expected_total = Σ expected_device，
    observed_total = Σ observed_device，coverage_percent 钳制 0–100。
    """

    local_now, tz = _now_for_dashboard(dashboard_tz, now)
    today_key = local_now.date().isoformat()
    start_date = local_now.date() - timedelta(days=FINE_ACTIVITY_DAYS)
    start_day = start_date.isoformat()
    end_day = (local_now.date() + timedelta(days=1)).isoformat()
    # Device-local dates can differ by two days across UTC-12 and UTC+14.
    # Keep complete device days for the SQL delta, then trim in the viewer's zone.
    rows = _load_fine_buckets(
        db,
        (start_date - timedelta(days=2)).isoformat(),
        (local_now.date() + timedelta(days=3)).isoformat(),
    )

    by_device: dict[str, list[dict]] = {}
    for device_id, group in groupby(rows, key=lambda row: row["device_id"]):
        by_device[device_id] = list(group)

    hourly: dict[int, int] = {h: 0 for h in range(24)}
    has_today_hourly = False
    fine_daily: dict[str, int] = {}
    device_diags: list[dict] = []
    expected_total = 0
    observed_total = 0
    first_samples: list = []
    last_samples: list = []

    for device_id, device_rows in by_device.items():
        expected_interval_ms = max(
            int((sync_intervals or {}).get(device_id) or 0),
            BUCKET_MS,
        )
        deltas = _deltas_for_device(
            device_rows, expected_interval_ms=expected_interval_ms
        )
        if not deltas:
            continue
        latest_day = max(r["local_day"] for r in device_rows)
        latest_deltas = [d for d in deltas if d["local_day"] == latest_day]
        cov = _coverage_for_device(
            latest_deltas, expected_interval_ms=expected_interval_ms
        )
        device_diags.append(
            {
                "device_id": cov["device_id"],
                "first_sample_at": cov["first_sample_at"],
                "last_sample_at": cov["last_sample_at"],
                "expected_buckets": cov["expected_buckets"],
                "observed_buckets": cov["observed_buckets"],
                "gap_count": cov["gap_count"],
                "reset_count": cov["reset_count"],
                "expected_interval_ms": cov["expected_interval_ms"],
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
            if not start_day <= dash_day <= end_day:
                continue
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
    archive_from = (local_now.date() - timedelta(days=ACTIVITY_DAILY_DAYS)).isoformat()
    archive_to = (date.fromisoformat(start_day) - timedelta(days=1)).isoformat()
    archive = query_daily_archive(
        db, from_day=archive_from, to_day=archive_to, limit=ACTIVITY_DAILY_DAYS
    )
    daily_map: dict[str, int] = {
        item["day"]: int(item["tokens"] or 0)
        for item in archive["items"]
    }
    for day, total in fine_daily.items():
        daily_map[day] = total

    hourly_buckets = (
        [{"hour": h, "total": hourly.get(h, 0)} for h in range(24)]
        if has_today_hourly
        else []
    )
    return {
        "time_zone": str(tz),
        "hourly": hourly_buckets,
        "hourly_day": today_key,
        "daily_day_basis": (
            "hybrid-dashboard-and-device-local"
            if archive["items"]
            else "dashboard-time-zone"
        ),
        "daily_mixed_basis": bool(archive["items"]),
        "daily_archive_cutover_day": archive_to if archive["items"] else None,
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


def _session_aggregate_time(stats: dict, now: Any = None) -> datetime:
    """Use the upstream aggregation clock, not a later Cloud response time.

    aggregateDevices stamps updatedAt separately from its nowMs argument. Its
    device ageMs preserves that exact argument, including at a window boundary.
    """
    for device in stats.get("devices") or []:
        age = device.get("ageMs")
        received = _parse_bucket_dt(device.get("receivedAt") or device.get("updatedAt"))
        if received is not None and isinstance(age, (int, float)) and not isinstance(age, bool) and math.isfinite(age):
            try:
                return (received + timedelta(milliseconds=age)).astimezone(timezone.utc)
            except OverflowError:
                pass
    for field in ("updatedAt", "generatedAt"):
        stamp = _parse_bucket_dt(stats.get(field))
        if stamp is not None:
            return stamp.astimezone(timezone.utc)
    return _now_for_dashboard("UTC", now)[0]


def _session_period_expired(device: dict, period: str, now: datetime) -> bool:
    """Mirror vendored usage.js isPeriodExpired on normalized stats devices."""
    if period == "allTime":
        return False
    window = (device.get("periodWindows") or {}).get(period) or {}
    end = _parse_bucket_dt(window.get("endsAt"))
    if end is not None and end.timestamp() > 0:
        return now >= end
    # Upstream recordDate uses updatedAt || receivedAt, not the receipt date
    # preferentially: a fresh delivery must not revive yesterday's snapshot.
    recorded = _parse_bucket_dt(device.get("updatedAt") or device.get("receivedAt"))
    if recorded is None:
        return False
    recorded = recorded.astimezone(timezone.utc)
    if period == "today":
        return recorded.date() != now.date()
    if period == "month":
        return (recorded.year, recorded.month) != (now.year, now.month)
    return False


def _current_session_devices(stats: dict, period: str, now: Any = None) -> list[dict]:
    reference = _session_aggregate_time(stats, now)
    return [device for device in stats.get("devices") or []
            if not _session_period_expired(device, period, reference)]


_THROUGHPUT_FIELDS = ("timedTokens", "timedOutputTokens", "timedDurationMs")


def _model_throughput_partial(stats: dict, now: Any = None) -> dict:
    """按模型计时的补充表；官方 totals 原样不动。

    官方聚合只要有一台当前设备的某个周期缺 modelThroughput，就删掉该周期整张表
    （不把缺失当零），面板于是丢掉全部模型速度。这里只用该周期未过期、报了计时的
    设备补出一份，并按模型记下有几台设备用过却没报计时，由面板标明速度没算进它们。
    官方表完整时不补；没有任何设备报计时时也不补。
    """
    result: dict = {}
    for period in ("today", "month", "allTime"):
        total = (stats.get("periods") or {}).get(period)
        if not isinstance(total, dict) or isinstance(total.get("modelThroughput"), dict):
            continue
        models: dict = {}
        missing: dict = {}
        for device in _current_session_devices(stats, period, now):
            data = (device.get("periods") or {}).get(period) or {}
            throughput = data.get("modelThroughput")
            if not isinstance(throughput, dict):
                for model, tokens in (data.get("models") or {}).items():
                    if isinstance(tokens, (int, float)) and not isinstance(tokens, bool) and tokens > 0:
                        missing[str(model)] = missing.get(str(model), 0) + 1
                continue
            for model, counters in throughput.items():
                if not isinstance(counters, dict):
                    continue
                slot = models.setdefault(str(model), dict.fromkeys(_THROUGHPUT_FIELDS, 0))
                for field in _THROUGHPUT_FIELDS:
                    value = counters.get(field)
                    if (isinstance(value, (int, float)) and not isinstance(value, bool)
                            and math.isfinite(value) and value >= 0):
                        slot[field] += int(value)
        if models:
            result[period] = {"models": models, "missingDevices": missing}
    return result


def _collect_sessions(stats: dict, period: str = "today", *, now: Any = None) -> tuple[dict, list[dict]]:
    """各设备指定周期 sessions 拍平；缺失观察不填零。

    跨设备主键 deviceId:client:sessionId——不同设备出现相同 client:sessionId
    时两条都保留（不互相删除）；仅在存在官方稳定跨设备标识且内容一致时才
    会附 duplicate_group（当前官方无此标识，恒不附）。
    """
    by_key: dict[str, dict] = {}
    for device in _current_session_devices(stats, period, now):
        periods = device.get("periods") or {}
        source_period = periods.get(period) or {}
        sessions = source_period.get("sessions")
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
                # Upstream normalization loses original field-presence evidence.
                # Never attest that a normalized zero was actually measured.
                "zeroValuesUnconfirmed": True,
                "sessionId": session_id,
                "tokens": tokens,
                "costUsd": value.get("costUsd", value.get("cost")),
                "models": models if isinstance(models, dict) else {},
                "project": value.get("projectLabel") or value.get("project"),
                "startedAt": value.get("startedAt"),
                "lastUsedAt": value.get("lastUsedAt"),
                "device": display,
            }
            # Canonical titles here have already passed the official server's
            # device-consent and generation checks. Never fall back to previews
            # or compatibility message/title fields.
            title = value.get("title")
            if isinstance(title, str) and title.strip():
                item["title"] = title.strip()[:160]
            # Keep absent observations absent: an older client has no evidence
            # that a turn is still running or that its context is empty.
            for field in (
                "contextTokens", "contextWindow", "turnEnded", "sessionKind", "archived",
                "waitingForInput", "liveActivity", "promptCache", "unpricedTokens",
                "timedOutputTokens", "timedDurationMs", "parentSessionId", "parentClient",
                "nativeSessionId", "t3ThreadId", "usageSource", "usageCoverage",
                "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                "reasoningTokens", "messageCount", "modelCosts", "providers", "projectId",
                "reasoningEffort",
            ):
                if field in value:
                    item[field] = value[field]
            if isinstance(device.get("stale"), bool):
                item["deviceStale"] = device["stale"]
            item["deviceId"] = device.get("deviceId")
            # sessionId 解析不出来（键无冒号且载荷未带）时回退原始键，
            # 避免多个会话坍缩到同一个 dedup 键互相覆盖
            dedup_id = session_id or str(key)
            item["key"] = f"{device.get('deviceId')}:{client}:{dedup_id}"
            by_key[item["key"]] = item
    all_sessions = sorted(by_key.values(), key=lambda s: s["tokens"], reverse=True)
    omitted_counts = stats.get("sessionDetailsOmitted")
    omitted_count = (
        int(omitted_counts.get(period) or 0)
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


def _session_period_details(stats: dict, period: str, *, now: Any = None) -> tuple[dict, list[dict]]:
    """Describe only synchronized session accounting, never local transcript detail."""
    if period == "allTime":
        return {
            "period": period, "availability": "unavailable", "reason": "not-synced",
            "sessions_total": 0, "sessions_returned": 0, "sessions_omitted_count": 0,
            "dashboard_omitted_count": 0, "session_details_incomplete": False,
            "call_details_available": False, "message_content_available": False,
            "tool_events_available": False,
        }, []
    reference = _session_aggregate_time(stats, now)
    meta, sessions = _collect_sessions(stats, period, now=reference)
    dashboard_omitted = max(0, meta["sessions_total"] - meta["sessions_returned"])
    incomplete = meta["session_details_incomplete"] or dashboard_omitted > 0
    available = bool(sessions) or any(
        isinstance(((device.get("periods") or {}).get(period) or {}).get("sessions"), dict)
        for device in _current_session_devices(stats, period, reference)
    )
    return {
        **meta, "period": period,
        "availability": "partial" if incomplete else ("available" if available else "unavailable"),
        "reason": "omitted" if incomplete else ("no-session-records" if not sessions else None),
        "dashboard_omitted_count": dashboard_omitted,
        "session_details_incomplete": incomplete,
        "call_details_available": False, "message_content_available": False,
        "tool_events_available": False,
    }, sessions


def _collect_projects(stats: dict, period: str = "allTime", *, now: Any = None) -> list[dict]:
    """官方聚合 periods.<period>.projects 规范化；devices 归属从同期未过期设备的 projects 反查。"""
    periods = stats.get("periods") or {}
    projects = (periods.get(period) or {}).get("projects")
    if not isinstance(projects, dict):
        return []
    out: dict[str, dict] = {}
    for key, value in projects.items():
        if not isinstance(value, dict):
            continue
        clients = value.get("clients")
        models = value.get("models")
        project_item = {
            "label": str(value.get("label") or key),
            "tokens": _int(value.get("tokens") or value.get("totalTokens")),
            "costUsd": _float(value.get("costUsd") or value.get("cost")),
            "clients": {
                str(c): _int(t)
                for c, t in (clients.items() if isinstance(clients, dict) else [])
            },
            # v0.74 起官方带出，合计不超过 tokens；旧版客户端上报的项目没有
            # models，合计可以小于 tokens。只收非负整数，异常值丢弃而不是记 0。
            "models": {
                str(m): t
                for m, t in (models.items() if isinstance(models, dict) else [])
                if isinstance(t, int) and not isinstance(t, bool) and t >= 0
            },
            "devices": [],
        }
        if "unpricedTokens" in value:
            project_item["unpricedTokens"] = _int(value.get("unpricedTokens"))
        out[str(key)] = project_item
    for device in _current_session_devices(stats, period, now):
        dev_projects = ((device.get("periods") or {}).get(period) or {}).get("projects")
        if not isinstance(dev_projects, dict):
            continue
        display = _device_display(device)
        for key in dev_projects:
            bucket = out.get(str(key))
            if bucket is not None and display not in bucket["devices"]:
                bucket["devices"].append(display)
    return sorted(out.values(), key=lambda p: p["tokens"], reverse=True)


def _projects_incomplete(stats: dict, period: str) -> bool:
    """镜像上游 projectBreakdownIncomplete：累计看 projectsIncomplete，今日、本月看 periodProjectsOmitted。"""
    if period == "allTime":
        return stats.get("projectsIncomplete") is True
    omitted = stats.get("periodProjectsOmitted")
    return isinstance(omitted, dict) and _int(omitted.get(period)) > 0


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

    session_now = _session_aggregate_time(stats, now)
    sessions_meta, sessions = _collect_sessions(stats, now=session_now)
    period_details = {period: _session_period_details(stats, period, now=session_now) for period in ("today", "month", "allTime")}
    projects_by_period = {period: _collect_projects(stats, period, now=session_now) for period in ("today", "month", "allTime")}

    # v2 扩展：活动口径 / 每设备窗口 / 降级信息（P0-3 / P1-4）
    partial_errors: list[dict] = []
    try:
        sync_intervals = {
            str(device.get("deviceId")): _int(device.get("syncUploadIntervalMs"))
            for device in stats.get("devices") or []
            if device.get("deviceId") is not None
        }
        activity = activity_report(
            db,
            dashboard_time_zone,
            now=now,
            sync_intervals=sync_intervals,
        )
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
            "daily_day_basis": "dashboard-time-zone",
            "daily_mixed_basis": False,
            "daily_archive_cutover_day": None,
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
    trend_days, trend_rows = trend_last_rows(db, TREND_DAYS)
    health_fields = snapshot_health(db)

    overview = {
        "overview_schema_version": 2,
        "generated_at": stats.get("updatedAt") or stats.get("generatedAt"),
        **health_fields,
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
        "model_throughput_partial": _model_throughput_partial(stats, now),
        "devices": devices,
        "trend": merge_trend_with_history(
            summarize_trend(trend_days, trend_rows), history, days=TREND_DAYS
        ),
        "trend_models": merge_trend_with_history(
            summarize_trend_models(trend_rows), history, days=TREND_DAYS,
            with_models=True,
        ),
        "activity": activity,
        "period_windows": _latest_period_windows(stats),  # deprecated
        "period_windows_by_device": windows_by_device,
        "dashboard_period": dashboard_period,
        "limits": _collect_limits(stats),
        "sessions": sessions,
        "sessions_omitted": sessions_meta["session_details_incomplete"],  # deprecated
        "sessions_meta": sessions_meta,
        "sessions_by_period": {period: detail[1] for period, detail in period_details.items()},
        "sessions_meta_by_period": {period: detail[0] for period, detail in period_details.items()},
        "projects": projects_by_period["allTime"],
        "projects_by_period": projects_by_period,
        "projects_meta_by_period": {
            period: {"incomplete": _projects_incomplete(stats, period)} for period in projects_by_period
        },
        "diagnostics": _collect_diagnostics(stats),
    }
    if history is None:
        overview["partial"] = True
        overview["partial_errors"].append({"code": "history_unavailable", "source": "tm-core"})
    return overview


def _dashboard_period(dashboard_tz: str, now: Any = None) -> dict:
    """仪表盘时区的当前 today/month 窗口（供前端展示口径）。"""

    now, _ = _now_for_dashboard(dashboard_tz, now)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    next_day = today_start + timedelta(days=1)
    month_start = today_start.replace(day=1)
    if now.month == 12:
        next_month = month_start.replace(year=now.year + 1, month=1)
    else:
        next_month = month_start.replace(month=now.month + 1)

    return {
        "time_zone": dashboard_tz,
        "today": {"key": today_start.date().isoformat(), "endsAt": utc_z(next_day)},
        "month": {
            "key": today_start.strftime("%Y-%m"),
            "endsAt": utc_z(next_month),
        },
    }


class OverviewCache:
    """Overview 响应的内存缓存：TTL 过期 + 写入端显式失效。

    单 worker 单进程，不需要跨进程共享。缓存粒度是整个 overview
    JSON dict——命中时零 HTTP + 零 SQLite + 零 CPU 组装。
    """

    __slots__ = (
        "_ttl",
        "_data",
        "_expires_at",
        "_built_at",
        "_generation",
        "_lock",
        "_inflight",
        "_time_zones",
    )

    def __init__(self, ttl_seconds: float = 30.0):
        self._ttl = ttl_seconds
        self._data: Optional[dict] = None
        self._expires_at: float = 0.0
        self._built_at: float = 0.0
        self._generation = 0
        self._inflight: asyncio.Future | None = None
        self._lock = Lock()
        self._time_zones: OrderedDict[str, OverviewCache] = OrderedDict()

    def for_time_zone(self, time_zone: str) -> OverviewCache:
        with self._lock:
            cache = self._time_zones.get(time_zone)
            if cache is None:
                cache = OverviewCache(self._ttl)
                self._time_zones[time_zone] = cache
                if len(self._time_zones) > 8:
                    self._time_zones.popitem(last=False)
            else:
                self._time_zones.move_to_end(time_zone)
            return cache

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def get(self, *, allow_stale: bool = False) -> Optional[dict]:

        with self._lock:
            if self._data is None:
                return None
            now = _time.monotonic()
            if now < self._expires_at:
                return self._data
            if allow_stale and self._built_at and (now - self._built_at) <= (2 * self._ttl):
                return self._data
            return None

    def put(self, data: dict, *, generation: int | None = None) -> None:

        with self._lock:
            now = _time.monotonic()
            self._data = data
            self._built_at = now
            # H-4：代数不匹配也替换数据（比旧的新），但立即过期，避免把过期结果当新鲜。
            if generation is not None and generation != self._generation:
                self._expires_at = 0.0
                return
            self._expires_at = now + self._ttl

    def invalidate(self) -> None:
        with self._lock:
            self._generation += 1
            self._expires_at = 0.0
            for cache in self._time_zones.values():
                cache.invalidate()

    def claim_refresh(self) -> tuple[bool, asyncio.Future]:
        with self._lock:
            if self._inflight is not None:
                return False, self._inflight
            self._inflight = asyncio.get_running_loop().create_future()
            return True, self._inflight

    def finish_refresh(self, data: dict) -> None:
        with self._lock:
            fut = self._inflight
            self._inflight = None
        if fut is not None and not fut.done():
            fut.set_result(data)

    def fail_refresh(self, exc: BaseException) -> None:
        with self._lock:
            fut = self._inflight
            self._inflight = None
        if fut is not None and not fut.done():
            fut.set_exception(exc)
            # A refresh can fail without any followers. Observe the exception
            # here to avoid an unhandled-Future warning; awaiters still receive it.
            fut.exception()


def build_tm_overview_router(settings: Settings, db: Database) -> tuple[APIRouter, OverviewCache]:
    router = APIRouter()
    overview_cache = OverviewCache(
        ttl_seconds=float(settings.overview_cache_seconds)
    )

    def _request_time_zone(request: Request) -> str:
        time_zone = request.headers.get("X-CM-Time-Zone")
        if time_zone is None:
            return settings.dashboard_time_zone
        if len(time_zone) > 128 or _zone(time_zone) is None:
            raise HTTPException(400, "X-CM-Time-Zone 必须是有效 IANA 时区")
        return time_zone

    def _resolve_scope(
        request: Request, binding: AccessBinding
    ) -> tuple[Database, Any, OverviewCache, Any]:
        if binding.tenant_id == "default":
            if not settings.tm_ingest_secret:
                raise CodedHTTPException(
                    404, "token_monitor_secret_unconfigured", "未启用 token-monitor 接入"
                )
            return (
                db,
                getattr(request.app.state, "tm_core", None),
                overview_cache,
                getattr(request.app.state, "provider_status", None),
            )
        tenants_map = getattr(request.app.state, "tm_tenants", None) or {}
        scope = tenants_map.get(binding.tenant_id)
        if scope is None:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return scope.db, scope.core, scope.overview_cache, scope.provider_status

    def _fetch_sync(core: TmCore, path: str) -> tuple[Optional[dict], Optional[str]]:
        """同步辅助读取（测试 TestClient 回退）。"""
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

    def _assemble_overview(
        target_db: Database,
        stats: dict,
        history: Optional[dict],
        history_error: Optional[str],
        raw_devices: Optional[list],
        devices_error: Optional[str],
        time_zone: str,
    ) -> dict:
        overview = build_overview(
            target_db,
            stats,
            history=history,
            raw_devices=raw_devices,
            dashboard_time_zone=time_zone,
            provider_status_enabled=settings.provider_status_enabled,
        )
        if history_error:
            overview["partial"] = True
            errors = overview["partial_errors"]
            # build_overview 对 history is None 已追加过无 reason 的基础条目；
            # 这里升级它而不是再追加一条，避免同一错误渲染两遍
            existing = next(
                (e for e in errors if e.get("code") == "history_unavailable"), None
            )
            if existing is not None:
                existing["reason"] = history_error
            else:
                errors.append(
                    {"code": "history_unavailable", "source": "tm-core", "reason": history_error}
                )
        if devices_error:
            overview["partial"] = True
            overview["partial_errors"].append(
                {"code": "devices_badges_unavailable", "source": "tm-core", "reason": devices_error}
            )
        return overview

    def _stale_overview(cache: OverviewCache, reason: str) -> Optional[dict]:
        cached = cache.get(allow_stale=True)
        if cached is None:
            return None
        # Do not mutate the cached response or its existing partial errors.
        errors = [dict(item) for item in cached.get("partial_errors", [])]
        errors.append({"code": "overview_stale", "source": "cloud-hub", "reason": reason})
        return {**cached, "partial": True, "partial_errors": errors}

    @router.get("/api/v1/tm/overview")
    async def tm_overview(request: Request) -> dict:
        binding = resolve_access_binding(request, settings)
        target_db, core, cache, _provider_svc = _resolve_scope(request, binding)
        time_zone = _request_time_zone(request)
        if time_zone != settings.dashboard_time_zone:
            cache = cache.for_time_zone(time_zone)

        generation = cache.generation
        cached = cache.get()
        if cached is not None:
            return cached
        owned, waiter = cache.claim_refresh()
        if not owned:
            try:
                # One client cancelling/timing out must not cancel the
                # shared refresh result for every other request.
                return await asyncio.wait_for(
                    asyncio.shield(waiter), OVERVIEW_REFRESH_TIMEOUT_SECONDS
                )
            except Exception as exc:
                # asyncio.TimeoutError 在 3.11 起是内置 TimeoutError 的别名，
                # 更早版本两者无继承关系——wait_for 抛的是前者，必须按前者判。
                timed_out = isinstance(exc, asyncio.TimeoutError) or (
                    isinstance(exc, HTTPException) and exc.status_code == 504
                )
                stale = _stale_overview(cache, "refresh_timeout" if timed_out else "refresh_failed")
                if stale is not None:
                    return stale
                if isinstance(exc, asyncio.TimeoutError):
                    raise HTTPException(504, "总览刷新超时，请稍后重试") from exc
                raise

        def _stats_sync():
            data, _error = _fetch_sync(core, "/api/stats")
            if data is None:
                raise HTTPException(status_code=502, detail="tm-core 聚合不可用")
            return data

        def _build() -> dict:
            with ThreadPoolExecutor(max_workers=3) as pool:
                f_stats = pool.submit(_stats_sync)
                f_hist = pool.submit(_fetch_sync, core, "/api/history")
                f_dev = pool.submit(_fetch_sync, core, "/api/devices")
                stats = f_stats.result()
                history, history_error = f_hist.result()
                raw, devices_error = f_dev.result()
            raw_devices = raw.get("devices") if isinstance(raw, dict) else None
            return _assemble_overview(
                target_db, stats, history, history_error, raw_devices, devices_error, time_zone
            )

        try:
            overview = await asyncio.wait_for(
                asyncio.to_thread(_build), OVERVIEW_REFRESH_TIMEOUT_SECONDS
            )
            cache.put(overview, generation=generation)
            cache.finish_refresh(overview)
            return overview
        except BaseException as exc:
            # Cancelling the owner must release the single-flight slot too.
            # Followers get a retryable failure, not someone else's cancellation.
            failure = exc
            if isinstance(exc, asyncio.CancelledError):
                failure = HTTPException(503, "总览刷新中断，请稍后重试")
            elif isinstance(exc, asyncio.TimeoutError):
                failure = HTTPException(504, "总览刷新超时，请稍后重试")
            cache.fail_refresh(failure)
            if not isinstance(exc, Exception):
                raise
            stale = _stale_overview(
                cache,
                "refresh_timeout" if isinstance(exc, asyncio.TimeoutError) else "refresh_failed",
            )
            if stale is not None:
                return stale
            if failure is not exc:
                raise failure from exc
            raise

    @router.get("/api/v1/tm/subscriptions")
    def tm_subscriptions_read(request: Request) -> dict:
        """面板只读订阅清单：服务端持 TM 密钥向 tm-core 取数，ACCESS_TOKEN 鉴权。"""
        binding = resolve_access_binding(request, settings)
        _target_db, core, _cache, _provider_svc = _resolve_scope(request, binding)
        data, _ = _fetch_sync(core, "/api/subscriptions")
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
        binding = resolve_access_binding(request, settings)
        _target_db, core, _cache, service = _resolve_scope(request, binding)
        if not settings.provider_status_enabled:
            raise HTTPException(status_code=404, detail="provider-status 未启用")

        stats, stats_error = await asyncio.to_thread(_fetch_sync, core, "/api/stats")
        observed = discover_providers(stats)
        client = getattr(request.app.state, "http_provider", request.app.state.http_async)
        envelope = await service.snapshot(client=client, observed=observed)
        if stats_error:
            envelope["partial"] = True
            envelope["errors"].append(
                {"error_code": "stats_unavailable", "source": "tm-core"}
            )
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
        binding = resolve_access_binding(request, settings)
        target_db, _core, _cache, _provider_svc = _resolve_scope(request, binding)
        time_zone = _request_time_zone(request)
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
            target_db,
            cursor=cursor,
            limit=limit,
            device_id=device_id,
            from_day=from_day,
            to_day=to,
        )
        return {
            "schema_version": 1,
            "day_basis": "device-local",
            "dashboard_time_zone": time_zone,
            "retention_days": HARD_RETENTION_DAYS,
            "mixed_time_zones": page["mixed_time_zones"],
            "device_time_zone": page["device_time_zone"],
            "items": page["items"],
            "next_cursor": page["next_cursor"],
            "has_more": page["has_more"],
            "partial": page["partial"],
            "partial_errors": page["partial_errors"],
        }

    return router, overview_cache
