"""token-monitor hub 兼容层：让本机 token-monitor widget 直接把数据推到云端。

实现 token-monitor hub 的服务端协议（依据其 docs/API.md 与 src/hub/server.js）：
- POST /api/ingest      设备摘要推送（Bearer secret 或 X-Token-Monitor-Secret）
- GET  /api/health      无鉴权健康检查（不含 hubBuild → 按官方文档视为
                        "legacy Hub"，与其客户端保持兼容）
- GET  /api/stats       聚合统计（widget / API 客户端可读）
- GET  /api/devices     设备列表
- DELETE /api/devices/:id  删除设备

与官方 Node hub 的关键差别：官方 hub 只在内存保存每台设备最新一份摘要，
本层把摘要**持久化到 SQLite**（最新全量 payload + 轻量历史快照），并以
/api/v1/tm/overview 提供网页面板数据。不支持 SSE 广播——widget 的实时
刷新仍走本地，本层用于远程网页查看与留存。
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from .auth import require_access_token
from .config import Settings
from .db import Database
from .services import utc_now

TM_SCHEMA = """
CREATE TABLE IF NOT EXISTS tm_devices (
    device_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    os_name TEXT NOT NULL DEFAULT '',
    os_version TEXT NOT NULL DEFAULT '',
    agent_version TEXT NOT NULL DEFAULT '',
    agent_runtime TEXT NOT NULL DEFAULT '',
    tracked_clients TEXT NOT NULL DEFAULT '[]',
    projects_enabled INTEGER NOT NULL DEFAULT 0,
    history_available INTEGER NOT NULL DEFAULT 0,
    sync_upload_interval_ms INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tm_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    day TEXT NOT NULL,
    today_total INTEGER NOT NULL DEFAULT 0,
    today_output INTEGER NOT NULL DEFAULT 0,
    today_cache_read INTEGER NOT NULL DEFAULT 0,
    today_cache_write INTEGER NOT NULL DEFAULT 0,
    today_unclassified INTEGER NOT NULL DEFAULT 0,
    today_cost REAL NOT NULL DEFAULT 0,
    month_total INTEGER NOT NULL DEFAULT 0,
    month_cost REAL NOT NULL DEFAULT 0,
    all_time_total INTEGER NOT NULL DEFAULT 0,
    all_time_cost REAL NOT NULL DEFAULT 0,
    models_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tm_snapshots_device_time
    ON tm_snapshots(device_id, received_at);
CREATE INDEX IF NOT EXISTS idx_tm_snapshots_day ON tm_snapshots(day);
"""

# 快照保留：近 7 天全分辨率（5 分钟级），更早每天保留最后一个；硬上限 370 天
FULL_RESOLUTION_DAYS = 7
HARD_RETENTION_DAYS = 370


def ensure_tm_schema(db: Database) -> None:
    with db._lock:
        db._conn.executescript(TM_SCHEMA)


# ---------------------------------------------------------------- 解析


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _period(raw: Any) -> dict[str, Any]:
    """解析一个周期对象（today/month/allTime），字段宽容缺失。"""
    if not isinstance(raw, dict):
        raw = {}
    clients = raw.get("clients") if isinstance(raw.get("clients"), dict) else {}
    client_models: dict[str, int] = {}
    client_models_raw = raw.get("clientModels")
    if isinstance(client_models_raw, dict):
        for _client, models in client_models_raw.items():
            if isinstance(models, dict):
                for model, tokens in models.items():
                    client_models[model] = client_models.get(model, 0) + _int(tokens)
    if not client_models and isinstance(raw.get("models"), dict):
        client_models = {m: _int(t) for m, t in raw["models"].items()}
    return {
        "totalTokens": _int(raw.get("totalTokens")),
        "outputTokens": _int(raw.get("outputTokens")),
        "cacheReadTokens": _int(raw.get("cacheReadTokens")),
        "cacheWriteTokens": _int(raw.get("cacheWriteTokens")),
        "unclassifiedTokens": _int(raw.get("unclassifiedTokens")),
        "costUsd": _float(raw.get("costUsd")),
        "clients": {str(k): _int(v) for k, v in clients.items()},
        "models": client_models,
    }


def _periods_of(summary: dict) -> dict[str, dict]:
    periods = summary.get("periods") if isinstance(summary.get("periods"), dict) else {}
    out = {}
    for name in ("today", "month", "allTime"):
        out[name] = _period(summary.get(name) or periods.get(name))
    return out


# ---------------------------------------------------------------- 写入


def apply_ingest(db: Database, summary: dict) -> dict:
    """幂等设备摘要入库：更新最新 payload + 追加轻量快照 + 保留策略清理。"""
    if not isinstance(summary, dict):
        raise ValueError("请求体无效")
    device_id = str(summary.get("deviceId") or "").strip()
    if not device_id or len(device_id) > 128:
        raise ValueError("缺少有效 deviceId")

    now = utc_now()
    day = now[:10]
    periods = _periods_of(summary)
    today, month, all_time = periods["today"], periods["month"], periods["allTime"]

    with db.transaction():
        db.execute(
            """
            INSERT INTO tm_devices (
                device_id, hostname, platform, os_name, os_version,
                agent_version, agent_runtime, tracked_clients,
                projects_enabled, history_available, sync_upload_interval_ms,
                first_seen_at, last_seen_at, payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                hostname = excluded.hostname,
                platform = excluded.platform,
                os_name = excluded.os_name,
                os_version = excluded.os_version,
                agent_version = excluded.agent_version,
                agent_runtime = excluded.agent_runtime,
                tracked_clients = excluded.tracked_clients,
                projects_enabled = excluded.projects_enabled,
                history_available = excluded.history_available,
                sync_upload_interval_ms = excluded.sync_upload_interval_ms,
                last_seen_at = excluded.last_seen_at,
                payload = excluded.payload
            """,
            (
                device_id,
                str(summary.get("hostname") or ""),
                str(summary.get("platform") or ""),
                str(summary.get("osName") or ""),
                str(summary.get("osVersion") or ""),
                str(summary.get("agentVersion") or ""),
                str(summary.get("agentRuntime") or ""),
                json.dumps(summary.get("trackedClients") or []),
                1 if summary.get("projectsEnabled") else 0,
                1 if summary.get("historyAvailable") else 0,
                _int(summary.get("syncUploadIntervalMs")),
                now,
                now,
                json.dumps(summary, ensure_ascii=False),
            ),
        )
        db.execute(
            """
            INSERT INTO tm_snapshots (
                device_id, received_at, day,
                today_total, today_output, today_cache_read, today_cache_write,
                today_unclassified, today_cost,
                month_total, month_cost, all_time_total, all_time_cost, models_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                device_id, now, day,
                today["totalTokens"], today["outputTokens"],
                today["cacheReadTokens"], today["cacheWriteTokens"],
                today["unclassifiedTokens"], today["costUsd"],
                month["totalTokens"], month["costUsd"],
                all_time["totalTokens"], all_time["costUsd"],
                json.dumps(today["models"], ensure_ascii=False),
            ),
        )
        _prune_snapshots(db, now)

    return {"ok": True, "deviceId": device_id, "receivedAt": now}


def _prune_snapshots(db: Database, now: str) -> None:
    """近 FULL_RESOLUTION_DAYS 天保留全部快照；更早每天只留最后一个；
    超过 HARD_RETENTION_DAYS 的全部删除。"""
    from datetime import datetime, timedelta, timezone

    now_dt = datetime.fromisoformat(now)
    full_cutoff = (now_dt - timedelta(days=FULL_RESOLUTION_DAYS)).isoformat()
    hard_cutoff = (
        now_dt - timedelta(days=HARD_RETENTION_DAYS)
    ).isoformat()
    db.execute(
        """
        DELETE FROM tm_snapshots
        WHERE received_at < ?
          AND id NOT IN (
              SELECT MAX(id) FROM tm_snapshots
              WHERE received_at >= ?
              GROUP BY device_id, day
          )
        """,
        (full_cutoff, hard_cutoff),
    )
    db.execute("DELETE FROM tm_snapshots WHERE received_at < ?", (hard_cutoff,))


# ---------------------------------------------------------------- 读取


def tm_device_count(db: Database) -> int:
    return int(db.fetchone("SELECT COUNT(*) AS n FROM tm_devices")["n"])


def _latest_device_rows(db: Database) -> list[dict]:
    rows = db.fetchall("SELECT * FROM tm_devices ORDER BY last_seen_at DESC")
    for row in rows:
        row["tracked_clients"] = json.loads(row.get("tracked_clients") or "[]")
        row["projects_enabled"] = bool(row.get("projects_enabled"))
        row["history_available"] = bool(row.get("history_available"))
    return rows


def _merge_periods(periods: list[dict]) -> dict:
    merged: dict[str, Any] = {
        "totalTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
        "cacheWriteTokens": 0, "unclassifiedTokens": 0, "costUsd": 0.0,
        "clients": {}, "models": {},
    }
    for p in periods:
        for key in ("totalTokens", "outputTokens", "cacheReadTokens",
                    "cacheWriteTokens", "unclassifiedTokens"):
            merged[key] += p[key]
        merged["costUsd"] += p["costUsd"]
        for client, tokens in p["clients"].items():
            merged["clients"][client] = merged["clients"].get(client, 0) + tokens
        for model, tokens in p["models"].items():
            merged["models"][model] = merged["models"].get(model, 0) + tokens
    return merged


def build_stats(db: Database) -> dict:
    """token-monitor 风格的聚合统计（GET /api/stats）。"""
    devices = _latest_device_rows(db)
    per_device = []
    raw_payloads = []
    for row in devices:
        try:
            payload = json.loads(row["payload"] or "{}")
        except ValueError:
            payload = {}
        raw_payloads.append(payload)
        periods = _periods_of(payload)
        per_device.append(
            {
                "deviceId": row["device_id"],
                "hostname": row["hostname"],
                "platform": row["platform"],
                "osName": row["os_name"],
                "osVersion": row["os_version"],
                "agentVersion": row["agent_version"],
                "agentRuntime": row["agent_runtime"],
                "receivedAt": row["last_seen_at"],
                "syncUploadIntervalMs": row["sync_upload_interval_ms"],
                "periods": periods,
            }
        )
    all_periods = [_periods_of(p) for p in raw_payloads]
    aggregated = {
        name: _merge_periods([p[name] for p in all_periods])
        for name in ("today", "month", "allTime")
    }
    return {
        "staleAfterMs": 15 * 60 * 1000,
        "generatedAt": utc_now(),
        "periods": aggregated,
        "devices": per_device,
    }


def build_overview(db: Database, trend_days: int = 30) -> dict:
    """网页面板数据（GET /api/v1/tm/overview）。"""
    stats = build_stats(db)
    devices = []
    for device in stats["devices"]:
        periods = device.pop("periods")
        device["today"], device["month"], device["allTime"] = (
            periods["today"], periods["month"], periods["allTime"]
        )
        devices.append(device)

    # 趋势：每台设备每天取最后一个快照的 today_total 相加 ≈ 当日总量
    trend_rows = db.fetchall(
        """
        SELECT day, SUM(today_total) AS total FROM (
            SELECT day, today_total,
                   ROW_NUMBER() OVER (
                       PARTITION BY device_id, day
                       ORDER BY received_at DESC, id DESC
                   ) AS rn
            FROM tm_snapshots
        ) WHERE rn = 1 GROUP BY day ORDER BY day DESC LIMIT ?
        """,
        (trend_days,),
    )
    return {
        "generated_at": stats["generatedAt"],
        "totals": stats["periods"],
        "devices": devices,
        "trend": [
            {"day": r["day"], "total": int(r["total"] or 0)}
            for r in reversed(trend_rows)
        ],
    }


# ---------------------------------------------------------------- 路由


def _tm_secret_ok(request: Request, settings: Settings) -> bool:
    secret = settings.tm_ingest_secret
    if not secret:
        return False
    header = request.headers.get("x-token-monitor-secret") or ""
    auth = request.headers.get("authorization") or ""
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    import hmac

    return hmac.compare_digest(
        (header or bearer).encode("utf-8"), secret.encode("utf-8")
    )


def build_tm_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    def tm_auth(request: Request) -> None:
        if not settings.tm_ingest_secret:
            raise HTTPException(status_code=404, detail="未启用 token-monitor 接入（缺少 TOKEN_MONITOR_SECRET）")
        if not _tm_secret_ok(request, settings):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @router.get("/api/health")
    def tm_health(request: Request) -> dict:
        # 不含 hubBuild：官方客户端按其文档将其视为 legacy Hub 并保持兼容
        return {
            "ok": True,
            "role": "hub",
            "runtime": "cloud-monitor",
            "deviceCount": tm_device_count(request.app.state.db),
            "secretRequired": bool(settings.tm_ingest_secret),
            "now": utc_now(),
        }

    @router.post("/api/ingest")
    def tm_ingest(request: Request, summary: dict) -> dict:
        tm_auth(request)
        try:
            return apply_ingest(request.app.state.db, summary)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/api/stats")
    def tm_stats(request: Request) -> dict:
        tm_auth(request)
        return build_stats(request.app.state.db)

    @router.get("/api/devices")
    def tm_devices(request: Request) -> dict:
        tm_auth(request)
        return build_stats(request.app.state.db)

    @router.delete("/api/devices/{device_id}")
    def tm_delete_device(device_id: str, request: Request) -> dict:
        tm_auth(request)
        db: Database = request.app.state.db
        with db.transaction():
            db.execute("DELETE FROM tm_devices WHERE device_id = ?", (device_id,))
            db.execute("DELETE FROM tm_snapshots WHERE device_id = ?", (device_id,))
        return {"ok": True, "deleted": device_id}

    @router.get("/api/v1/tm/overview")
    def tm_overview(request: Request) -> dict:
        require_access_token(request, settings)
        return build_overview(request.app.state.db)

    return router
