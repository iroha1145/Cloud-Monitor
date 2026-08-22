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
- period_windows: 最新设备的 periodWindows 透传（无则 None）。
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
    """每设备每本地日最后一个桶，按天合并 today_total 与 models_json。"""
    rows = db.fetchall(
        """
        SELECT local_day, today_total, models_json FROM (
            SELECT local_day, today_total, models_json,
                   ROW_NUMBER() OVER (
                       PARTITION BY device_id, local_day
                       ORDER BY bucket_start DESC
                   ) AS rn
            FROM tm_snapshot_buckets
        ) WHERE rn = 1 ORDER BY local_day
        """
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


def hourly_activity(db: Database) -> list[dict]:
    """最新本地日的 24 小时活动：today_total 相邻差分（钳 0）跨设备求和。"""
    row = db.fetchone("SELECT MAX(local_day) AS day FROM tm_snapshot_buckets")
    latest = row["day"] if row else None
    if not latest:
        return []
    rows = db.fetchall(
        """
        SELECT device_id, bucket_start, today_total
        FROM tm_snapshot_buckets
        WHERE local_day = ?
        ORDER BY device_id, bucket_start
        """,
        (latest,),
    )
    buckets = [0] * 24
    last_seen: dict[str, int] = {}
    for row in rows:
        value = _int(row["today_total"])
        delta = max(0, value - last_seen.get(row["device_id"], 0))
        last_seen[row["device_id"]] = value
        try:
            hour = int(str(row["bucket_start"])[11:13])
        except (TypeError, ValueError):
            continue
        if 0 <= hour < 24:
            buckets[hour] += delta
    return [{"hour": hour, "total": buckets[hour]} for hour in range(24)]


def daily_activity(
    db: Database, history: Optional[dict], days: int = ACTIVITY_DAILY_DAYS
) -> list[dict]:
    """近 N 天每日总量：快照趋势为主，缺失日用官方 history.daily 回填。"""
    totals = {row["day"]: row["total"] for row in trend_by_day(db, days)}
    if isinstance(history, dict):
        daily = history.get("daily")
        if isinstance(daily, list):
            for entry in daily:
                if not isinstance(entry, dict):
                    continue
                day = str(entry.get("date") or entry.get("day") or "")[:10]
                if not day:
                    continue
                # 同一天已有快照数据时快照优先（不回填覆盖）
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


def _collect_sessions(stats: dict) -> tuple[list[dict], bool]:
    """各设备 today 周期 sessions 拍平去重（留 tokens 大者），降序截 100。"""
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
            existing = by_key.get(f"{client}:{session_id}")
            if existing is None or tokens > existing["tokens"]:
                by_key[f"{client}:{session_id}"] = item
    sessions = sorted(by_key.values(), key=lambda s: s["tokens"], reverse=True)
    omitted_counts = stats.get("sessionDetailsOmitted")
    omitted = bool(isinstance(omitted_counts, dict) and omitted_counts.get("today"))
    return sessions[:SESSIONS_LIMIT], omitted


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

    sessions, sessions_omitted = _collect_sessions(stats)
    return {
        "generated_at": stats.get("updatedAt") or stats.get("generatedAt"),
        "staleAfterMs": stats.get("staleAfterMs"),
        "totals": stats.get("periods"),
        "devices": devices,
        "trend": trend_by_day(db),
        "trend_models": trend_models_by_day(db),
        "activity": {
            "hourly": hourly_activity(db),
            "daily": daily_activity(db, history),
        },
        "period_windows": _latest_period_windows(stats),
        "limits": _collect_limits(stats),
        "sessions": sessions,
        "sessions_omitted": sessions_omitted,
        "projects": _collect_projects(stats),
        "diagnostics": _collect_diagnostics(stats),
    }


def build_tm_overview_router(settings: Settings, db: Database, core: TmCore) -> APIRouter:
    router = APIRouter()

    def _require_core() -> None:
        if not settings.tm_ingest_secret:
            raise HTTPException(status_code=404, detail="未启用 token-monitor 接入")

    def _fetch(path: str) -> Optional[dict]:
        """辅助上游读取：失败时降级为 None（面板尽力展示，不 5xx）。"""
        try:
            resp = core.request("GET", path)
        except httpx.HTTPError as exc:
            log.warning("tm-core %s 读取失败（降级处理）: %s", path, exc)
            return None
        if resp.status_code != 200:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    @router.get("/api/v1/tm/overview")
    def tm_overview(request: Request) -> dict:
        require_access_token(request, settings)
        _require_core()
        try:
            resp = core.request("GET", "/api/stats")
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="tm-core 聚合不可用") from exc
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="tm-core 聚合不可用")
        stats = resp.json()
        history = _fetch("/api/history")
        raw = _fetch("/api/devices")
        raw_devices = raw.get("devices") if isinstance(raw, dict) else None
        return build_overview(db, stats, history=history, raw_devices=raw_devices)

    @router.get("/api/v1/tm/subscriptions")
    def tm_subscriptions_read(request: Request) -> dict:
        """面板只读订阅清单：服务端持 TM 密钥向 tm-core 取数，ACCESS_TOKEN 鉴权。"""
        require_access_token(request, settings)
        _require_core()
        data = _fetch("/api/subscriptions")
        if data is None:
            raise HTTPException(status_code=502, detail="tm-core 订阅数据不可用")
        subscriptions = data.get("subscriptions")
        return {
            "subscriptions": subscriptions if isinstance(subscriptions, list) else [],
            "updated_at": data.get("updatedAt") or None,
        }

    return router
