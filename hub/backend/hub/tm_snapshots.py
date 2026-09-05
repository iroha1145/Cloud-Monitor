"""token-monitor 历史快照：5 分钟桶，设备本地日归档。

- 桶起点 = producer 时间（payload.updatedAt，缺失用接收时间）按 5 分钟取整；
  UNIQUE(device_id, local_day, bucket_start)，同桶 UPSERT 保留最后一份 ——
  不会每次 ingest 无限追加，"5 分钟级"是真实分桶。
- local_day 优先级: periodWindows.today.key → timeZone+updatedAt 本地日 →
  today.endsAt 反推 → UTC 回退（tz 留空标注）。
- 保留策略: 近 7 天全分辨率；更早每 (device, local_day) 留最后一个桶；
  370 天硬删除。清理按阈值触发（距上次 >10 分钟），不每次 ingest 全表扫。
- limits-only 更新不产生 token 历史点。

旧版 tm_devices / tm_snapshots 表（v1 云端方案）按"不得删除数据"原则原样
保留：tm_snapshots 一次性搬入桶表；tm_devices 的 payload 在启动时回灌官方
Node hub（devices.json 成为最新态权威），两者都打上迁移标记。
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from .db import Database
from .services import utc_now

log = logging.getLogger("tm-snapshots")

BUCKET_MS = 5 * 60 * 1000
FULL_RESOLUTION_DAYS = 7
HARD_RETENTION_DAYS = 370
PRUNE_INTERVAL_SECONDS = 600

SCHEMA = """
CREATE TABLE IF NOT EXISTS tm_snapshot_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    local_day TEXT NOT NULL,
    bucket_start TEXT NOT NULL,
    today_total INTEGER NOT NULL DEFAULT 0,
    today_output INTEGER NOT NULL DEFAULT 0,
    today_cache_read INTEGER NOT NULL DEFAULT 0,
    today_cache_write INTEGER NOT NULL DEFAULT 0,
    today_unclassified INTEGER NOT NULL DEFAULT 0,
    today_components_recorded INTEGER,
    today_cost REAL NOT NULL DEFAULT 0,
    month_total INTEGER NOT NULL DEFAULT 0,
    month_cost REAL NOT NULL DEFAULT 0,
    all_time_total INTEGER NOT NULL DEFAULT 0,
    all_time_cost REAL NOT NULL DEFAULT 0,
    clients_json TEXT NOT NULL DEFAULT '{}',
    models_json TEXT NOT NULL DEFAULT '{}',
    device_time_zone TEXT NOT NULL DEFAULT '',
    producer_updated_at TEXT NOT NULL DEFAULT '',
    server_received_at TEXT NOT NULL DEFAULT '',
    UNIQUE(device_id, local_day, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_tm_buckets_day ON tm_snapshot_buckets(local_day);
CREATE INDEX IF NOT EXISTS idx_tm_buckets_device_time
    ON tm_snapshot_buckets(device_id, bucket_start);
CREATE INDEX IF NOT EXISTS idx_tm_buckets_dev_day_bucket
    ON tm_snapshot_buckets(device_id, local_day, bucket_start);

CREATE TABLE IF NOT EXISTS tm_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def ensure_schema(db: Database) -> None:
    with db._lock:
        db._conn.executescript(SCHEMA)
        columns = {row["name"] for row in db._conn.execute("PRAGMA table_info(tm_snapshot_buckets)")}
        if "today_components_recorded" not in columns:
            # NULL preserves old rows' missing provenance; do not backfill their zeros.
            db._conn.execute("ALTER TABLE tm_snapshot_buckets ADD COLUMN today_components_recorded INTEGER")
    _migrate_timestamp_format(db)


def utc_z(dt: datetime) -> str:
    """统一截止/比较时间：毫秒精度 UTC + Z 后缀。禁止 isoformat() 的 +00:00。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _migrate_timestamp_format(db: Database) -> None:
    """历史版本混存 '+00:00' 秒级文本：统一为毫秒 Z 格式（幂等）。

    meta 标记不能让后续新插入的 +00:00 行跳过；只要表里还有非 Z 文本就重跑。
    """
    leftover = db.fetchone(
        "SELECT 1 AS x FROM tm_snapshot_buckets"
        " WHERE instr(bucket_start, '+00:00') > 0"
        "    OR instr(server_received_at, '+00:00') > 0"
        "    OR instr(producer_updated_at, '+00:00') > 0"
        " LIMIT 1"
    )
    if _meta_get(db, "ts_format_ms_z") == "2" and leftover is None:
        return
    rows = db.fetchall(
        "SELECT id, bucket_start, server_received_at, producer_updated_at"
        " FROM tm_snapshot_buckets"
    )
    updates = []
    for row in rows:
        norm_bucket = norm_ts(row["bucket_start"]) if row["bucket_start"] else ""
        norm_recv = norm_ts(row["server_received_at"]) if row["server_received_at"] else ""
        norm_prod = (
            norm_ts(row["producer_updated_at"]) if row["producer_updated_at"] else ""
        )
        if (
            norm_bucket != row["bucket_start"]
            or norm_recv != row["server_received_at"]
            or norm_prod != row["producer_updated_at"]
        ):
            updates.append((norm_bucket, norm_recv, norm_prod, row["id"]))
    if updates:
        with db.transaction():
            db.executemany(
                "UPDATE tm_snapshot_buckets"
                " SET bucket_start=?, server_received_at=?, producer_updated_at=?"
                " WHERE id=?",
                updates,
            )
    _meta_set(db, "ts_format_ms_z", "2")


# ---------------------------------------------------------------- 本地日


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _valid_day_key(key: Any) -> Optional[str]:
    if not isinstance(key, str) or len(key) != 10:
        return None
    try:
        datetime.strptime(key, "%Y-%m-%d")
    except ValueError:
        return None
    return key


def resolve_local_day(
    *, period_windows: Any, updated_at: Any, received_at: Any
) -> tuple[str, str]:
    """返回 (local_day, 时区标注)。回退链按任务要求，UTC 回退显式标注。"""
    windows = period_windows if isinstance(period_windows, dict) else {}

    key = _valid_day_key((windows.get("today") or {}).get("key"))
    tz_name = windows.get("timeZone")
    tz = None
    if isinstance(tz_name, str) and tz_name:
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = None
    if key:
        return key, (tz_name if isinstance(tz_name, str) else "")

    producer = _parse_iso(updated_at) or _parse_iso(received_at)
    if producer is not None and tz is not None:
        return producer.astimezone(tz).date().isoformat(), tz_name

    ends_at = _parse_iso((windows.get("today") or {}).get("endsAt"))
    if ends_at is not None and tz is not None:
        # endsAt 是下一周期起点，反推其前一瞬间所在日
        return (
            (ends_at - timedelta(seconds=1)).astimezone(tz).date().isoformat(),
            tz_name,
        )

    if producer is not None:
        return producer.astimezone(timezone.utc).date().isoformat(), ""  # 兼容回退
    return datetime.now(timezone.utc).date().isoformat(), ""


def norm_ts(value: Any) -> str:
    """统一 UTC 存储/比较格式：毫秒精度 + Z 后缀。

    官方 receivedAt 为 '.792Z' 毫秒形态，历史版本曾混存 '+00:00' 秒级
    文本，文本比较会错序；所有写入统一经此函数。
    """
    dt = _parse_iso(value)
    if dt is None:
        raw = str(value or "")
        return raw
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bucket_start_of(producer: Optional[datetime]) -> str:
    base = producer or datetime.now(timezone.utc)
    ms = int(base.timestamp() * 1000)
    floored = (ms // BUCKET_MS) * BUCKET_MS
    return (
        datetime.fromtimestamp(floored / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# ---------------------------------------------------------------- 写入


COMPONENT_COLUMNS = {
    "outputTokens": "today_output",
    "cacheReadTokens": "today_cache_read",
    "cacheWriteTokens": "today_cache_write",
    "unclassifiedTokens": "today_unclassified",
}


def _component_counter(value: Any) -> Optional[int]:
    """A recorded zero differs from a missing or invalid component counter."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or int(value) != value:
        return None
    return int(value)


def _components_recorded(period: Any) -> int:
    """The official normalized snapshot supplied all counters, including zero.

    This records field provenance, not full classification: a valid snapshot
    may still contain unclassifiedTokens > 0.
    """
    if not isinstance(period, dict):
        return 0
    total = _component_counter(period.get("totalTokens"))
    values = [_component_counter(period.get(key)) for key in COMPONENT_COLUMNS]
    return int(total is not None and all(value is not None for value in values)
               and sum(value for value in values if value is not None) <= total)


def _period_field(period: Any, key: str) -> int:
    if not isinstance(period, dict):
        return 0
    value = period.get(key)
    try:
        value = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(value, 0)


def _period_cost(period: Any) -> float:
    if not isinstance(period, dict):
        return 0.0
    value = period.get("costUsd")
    try:
        value = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(value, 0.0)


def _stringify_dict(period: Any, key: str) -> str:
    value = period.get(key) if isinstance(period, dict) else None
    if not isinstance(value, dict):
        return "{}"
    clean = {}
    for k, v in value.items():
        if isinstance(k, str) and isinstance(v, (int, float)) and not isinstance(v, bool):
            clean[k] = max(int(v) if float(v).is_integer() else v, 0)
    return json.dumps(clean, ensure_ascii=False)


def write_snapshot(
    db: Database,
    *,
    device_id: str,
    record: dict,
    limits_only: bool,
    incoming: Optional[dict] = None,
    force_received_at: Optional[str] = None,
) -> Optional[dict]:
    """record = 官方合并后的设备记录；incoming = 本次上报的原始载荷。

    周期窗口优先用上报方声明（官方 normalize 会丢弃不完整的
    periodWindows，而设备本地日语义以生产者时区为准），合并记录兜底。
    limits-only 更新直接跳过（不制造 token 为 0 的历史点）。
    """
    if limits_only or not isinstance(record, dict):
        return None
    periods = record.get("periods") if isinstance(record.get("periods"), dict) else {}
    today = periods.get("today") or {}
    month = periods.get("month") or {}
    all_time = periods.get("allTime") or {}

    candidate_windows = None
    if isinstance(incoming, dict):
        candidate_windows = incoming.get("periodWindows")
        if not isinstance(candidate_windows, dict) or not candidate_windows:
            candidate_windows = None
    windows = candidate_windows or record.get("periodWindows")
    producer_stamp = None
    if isinstance(incoming, dict) and isinstance(incoming.get("updatedAt"), str):
        producer_stamp = incoming["updatedAt"]
    local_day, tz_name = resolve_local_day(
        period_windows=windows,
        updated_at=producer_stamp or record.get("updatedAt"),
        received_at=record.get("receivedAt"),
    )
    producer = _parse_iso(producer_stamp) or _parse_iso(record.get("updatedAt")) or _parse_iso(record.get("receivedAt"))
    received_at = force_received_at or record.get("receivedAt") or utc_now()
    received_at = norm_ts(received_at)
    bucket = bucket_start_of(producer)

    with db.transaction():
        db.execute(
            """
            INSERT INTO tm_snapshot_buckets (
                device_id, local_day, bucket_start,
                today_total, today_output, today_cache_read, today_cache_write,
                today_unclassified, today_components_recorded, today_cost,
                month_total, month_cost, all_time_total, all_time_cost,
                clients_json, models_json,
                device_time_zone, producer_updated_at, server_received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, local_day, bucket_start) DO UPDATE SET
                today_total = excluded.today_total,
                today_output = excluded.today_output,
                today_cache_read = excluded.today_cache_read,
                today_cache_write = excluded.today_cache_write,
                today_unclassified = excluded.today_unclassified,
                today_components_recorded = excluded.today_components_recorded,
                today_cost = excluded.today_cost,
                month_total = excluded.month_total,
                month_cost = excluded.month_cost,
                all_time_total = excluded.all_time_total,
                all_time_cost = excluded.all_time_cost,
                clients_json = excluded.clients_json,
                models_json = excluded.models_json,
                device_time_zone = excluded.device_time_zone,
                producer_updated_at = excluded.producer_updated_at,
                server_received_at = excluded.server_received_at
            WHERE excluded.server_received_at >= tm_snapshot_buckets.server_received_at
            """,
            (
                device_id, local_day, bucket,
                _period_field(today, "totalTokens"),
                _period_field(today, "outputTokens"),
                _period_field(today, "cacheReadTokens"),
                _period_field(today, "cacheWriteTokens"),
                _period_field(today, "unclassifiedTokens"),
                _components_recorded(today),
                _period_cost(today),
                _period_field(month, "totalTokens"), _period_cost(month),
                _period_field(all_time, "totalTokens"), _period_cost(all_time),
                _stringify_dict(today, "clients"),
                _stringify_dict(today, "models"),
                tz_name,
                norm_ts(record.get("updatedAt") or ""),
                received_at,
            ),
        )
    _prune_if_due(db)
    return {"device_id": device_id, "local_day": local_day, "bucket": bucket}


# ---------------------------------------------------------------- 清理


def _meta_get(db: Database, key: str) -> Optional[str]:
    row = db.fetchone("SELECT value FROM tm_meta WHERE key = ?", (key,))
    return row["value"] if row else None


def _meta_set(db: Database, key: str, value: str) -> None:
    db.execute(
        "INSERT INTO tm_meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _prune_if_due(db: Database) -> None:
    last = _parse_iso(_meta_get(db, "last_prune_at"))
    now_dt = datetime.now(timezone.utc)
    if last is not None and (now_dt - last).total_seconds() < PRUNE_INTERVAL_SECONDS:
        return
    prune_snapshots(db, now=now_dt)


def prune_snapshots(db: Database, *, now: Optional[datetime] = None) -> dict:
    """阈值触发的维护函数：也可手动/定时调用。

    7 天外每个 (device_id, local_day) 只保留真正最后一条快照
    （bucket_start DESC, server_received_at DESC, id DESC），不是 MAX(id)。
    截止时间统一毫秒 UTC Z，禁止 +00:00 文本与 Z 互比。
    """
    _migrate_timestamp_format(db)
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    now_dt = now_dt.astimezone(timezone.utc)
    full_cutoff = utc_z(now_dt - timedelta(days=FULL_RESOLUTION_DAYS))
    hard_cutoff = utc_z(now_dt - timedelta(days=HARD_RETENTION_DAYS))
    removed = {"full_res": 0, "hard": 0}
    with db.transaction():
        cur = db.execute(
            """
            DELETE FROM tm_snapshot_buckets
            WHERE id IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY device_id, local_day
                               ORDER BY bucket_start DESC,
                                        server_received_at DESC,
                                        id DESC
                           ) AS rn
                    FROM tm_snapshot_buckets
                    WHERE bucket_start < ?
                ) ranked
                WHERE ranked.rn > 1
            )
            """,
            (full_cutoff,),
        )
        removed["full_res"] = cur.rowcount or 0
        cur = db.execute(
            "DELETE FROM tm_snapshot_buckets WHERE bucket_start < ?", (hard_cutoff,)
        )
        removed["hard"] = cur.rowcount or 0
        _meta_set(db, "last_prune_at", utc_z(now_dt))
    return removed


LAST_ROW_WINDOW = """
    ROW_NUMBER() OVER (
        PARTITION BY device_id, local_day
        ORDER BY bucket_start DESC, server_received_at DESC, id DESC
    )
"""

DISTINCT_DAYS_SQL = """
SELECT DISTINCT local_day AS day
FROM tm_snapshot_buckets
WHERE {where}
ORDER BY local_day DESC
LIMIT ?
"""

LAST_ROWS_FOR_DAYS_SQL = """
SELECT device_id, local_day, today_total, today_cost,
       today_output, today_cache_read, today_cache_write,
       today_unclassified, today_components_recorded,
       clients_json, models_json, device_time_zone,
       bucket_start, server_received_at, id
FROM (
    SELECT device_id, local_day, today_total, today_cost,
           today_output, today_cache_read, today_cache_write,
           today_unclassified, today_components_recorded,
           clients_json, models_json, device_time_zone,
           bucket_start, server_received_at, id,
           {window} AS rn
    FROM tm_snapshot_buckets
    WHERE local_day IN ({days})
      {device_clause}
)
WHERE rn = 1
"""


def _last_rows_for_days(db: Database, days: list[str], device: Optional[str] = None) -> list[dict]:
    if not days:
        return []
    sql = LAST_ROWS_FOR_DAYS_SQL.format(
        window=LAST_ROW_WINDOW.strip(),
        days=",".join("?" * len(days)),
        device_clause="AND device_id = ?" if device else "",
    )
    return db.fetchall(sql, [*days, device] if device else days)


def _empty_daily_components() -> dict[str, Any]:
    return {
        "outputTokens": None,
        "cacheReadTokens": None,
        "cacheWriteTokens": None,
        "unclassifiedTokens": 0,
        "tokenComponentsAvailable": True,
        "componentsPartial": False,
    }


def _snapshot_components(row: dict) -> dict[str, Any]:
    """Recover one cumulative device/local-day row without borrowing another row.

    New snapshots preserve explicit zeros. Legacy default zeros have no field
    provenance, so only positive counters are evidence; their whole remaining
    total stays unclassified instead of being inferred as ordinary input.
    """
    total = _component_counter(row.get("today_total")) or 0
    raw = {key: _component_counter(row.get(column)) for key, column in COMPONENT_COLUMNS.items()}
    recorded = row.get("today_components_recorded") == 1 and all(value is not None for value in raw.values())
    observed_sum = sum(value for value in raw.values() if value is not None)
    if observed_sum > total:
        return {
            **_empty_daily_components(), "unclassifiedTokens": total,
            "tokenComponentsAvailable": False, "componentsPartial": True,
        }
    known = {
        key: value if value is not None and (recorded or value > 0) else None
        for key, value in raw.items() if key != "unclassifiedTokens"
    }
    classified = sum(value for value in known.values() if value is not None)
    unclassified = raw["unclassifiedTokens"] if recorded else total - classified
    available = recorded and unclassified == 0
    return {
        **known,
        "unclassifiedTokens": unclassified,
        "tokenComponentsAvailable": available,
        "componentsPartial": not available,
    }


def _merge_daily_components(item: dict, row: dict) -> None:
    components = _snapshot_components(row)
    for key in ("outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        value = components[key]
        if value is not None:
            item[key] = (item[key] or 0) + value
    item["unclassifiedTokens"] += components["unclassifiedTokens"]
    item["tokenComponentsAvailable"] = item["tokenComponentsAvailable"] and components["tokenComponentsAvailable"]
    item["componentsPartial"] = item["componentsPartial"] or components["componentsPartial"]


def valid_day_key(key: Any) -> Optional[str]:
    return _valid_day_key(key)


def _merge_token_map(dest: dict[str, int], raw: Any) -> bool:
    """合并 clients_json / models_json。损坏返回 False，调用方标 partial。"""
    if raw is None or raw == "":
        return True
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    for key, value in data.items():
        if not isinstance(key, str):
            continue
        try:
            token = int(value or 0)
        except (TypeError, ValueError):
            continue
        dest[key] = dest.get(key, 0) + max(token, 0)
    return True


def build_distinct_days_query(
    *,
    cursor: Optional[str] = None,
    from_day: Optional[str] = None,
    to_day: Optional[str] = None,
    device_id: Optional[str] = None,
) -> tuple[str, list[Any]]:
    """SQL 分页：按 local_day DESC 取页，不把 370 天载入 Python 再切片。"""
    clauses: list[str] = []
    params: list[Any] = []
    if device_id:
        clauses.append("device_id = ?")
        params.append(device_id)
    if cursor:
        clauses.append("local_day < ?")
        params.append(cursor)
    if from_day:
        clauses.append("local_day >= ?")
        params.append(from_day)
    if to_day:
        clauses.append("local_day <= ?")
        params.append(to_day)
    where = " AND ".join(clauses) if clauses else "1=1"
    return DISTINCT_DAYS_SQL.format(where=where), params


def query_daily_archive(
    db: Database,
    *,
    cursor: Optional[str] = None,
    limit: int = 30,
    device_id: Optional[str] = None,
    from_day: Optional[str] = None,
    to_day: Optional[str] = None,
) -> dict[str, Any]:
    """每 (device_id, local_day) 取真正最后一条，再按 day 跨设备聚合。

    day_basis 是设备本地日：多时区聚合不得声称 UTC/仪表盘日。
    """
    limit = max(1, min(int(limit), 90))
    cursor_day = valid_day_key(cursor) if cursor else None
    from_ok = valid_day_key(from_day) if from_day else None
    to_ok = valid_day_key(to_day) if to_day else None
    device = str(device_id).strip() if device_id else None

    sql, params = build_distinct_days_query(
        cursor=cursor_day, from_day=from_ok, to_day=to_ok, device_id=device
    )
    day_rows = db.fetchall(sql, (*params, limit + 1))
    has_more = len(day_rows) > limit
    days = [r["day"] for r in day_rows[:limit]]
    next_cursor = days[-1] if has_more and days else None

    if not days:
        return {
            "day_basis": "device-local",
            "items": [],
            "next_cursor": None,
            "has_more": False,
            "partial": False,
            "partial_errors": [],
            "mixed_time_zones": False,
            "device_time_zone": None,
            "retention_days": HARD_RETENTION_DAYS,
        }

    last_rows = _last_rows_for_days(db, days, device)

    grouped: dict[str, dict[str, Any]] = {
        day: {
            "day": day,
            "tokens": 0,
            "costUsd": 0.0,
            "perClient": {},
            "perModel": {},
            "deviceCount": 0,
            "complete": True,
            "coverage": None,
            "time_zones": [],
            **_empty_daily_components(),
        }
        for day in days
    }
    partial = False
    partial_errors: list[dict[str, str]] = []
    zones: set[str] = set()
    device_zone: Optional[str] = None

    for row in last_rows:
        day = row["local_day"]
        item = grouped.get(day)
        if item is None:
            continue
        item["tokens"] += int(row["today_total"] or 0)
        _merge_daily_components(item, row)
        try:
            item["costUsd"] += max(float(row["today_cost"] or 0), 0.0)
        except (TypeError, ValueError):
            pass
        item["deviceCount"] += 1
        tz_name = str(row["device_time_zone"] or "").strip()
        if tz_name:
            zones.add(tz_name)
            item["time_zones"].append(tz_name)
            device_zone = tz_name
        if not _merge_token_map(item["perClient"], row.get("clients_json")):
            partial = True
            item["complete"] = False
            partial_errors.append(
                {"code": "clients_json_corrupt", "day": day, "device_id": row["device_id"]}
            )
        if not _merge_token_map(item["perModel"], row.get("models_json")):
            partial = True
            item["complete"] = False
            partial_errors.append(
                {"code": "models_json_corrupt", "day": day, "device_id": row["device_id"]}
            )

    items = []
    for day in days:
        item = grouped[day]
        item["costUsd"] = round(item["costUsd"], 6)
        item.pop("time_zones", None)
        items.append(item)

    mixed = len(zones) > 1
    return {
        "day_basis": "device-local",
        "items": items,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "partial": partial,
        "partial_errors": partial_errors,
        "mixed_time_zones": mixed,
        "device_time_zone": device_zone if device else None,
        "retention_days": HARD_RETENTION_DAYS,
    }


def trend_by_day(db: Database, days: int = 30) -> list[dict]:
    """每设备每天取同一个最后桶的总量、费用和组成，按 local_day 汇总。

    先用日期索引选出所需日期，再只对这些日期开窗。与日归档共享最后行
    的排序和组件判定，不从稀疏 allTime 锚点差分或借用当前周期组成。
    """
    days = max(0, int(days))
    if not days:
        return []
    day_floor = (datetime.now(timezone.utc) - timedelta(days=days + 1)).date().isoformat()
    day_rows = db.fetchall(
        DISTINCT_DAYS_SQL.format(where="local_day >= ?"),
        (day_floor, days),
    )
    selected_days = [row["day"] for row in day_rows]
    grouped = {
        day: {"day": day, "total": 0, "costUsd": 0.0, **_empty_daily_components()}
        for day in selected_days
    }
    for row in _last_rows_for_days(db, selected_days):
        item = grouped[row["local_day"]]
        item["total"] += int(row["today_total"] or 0)
        try:
            item["costUsd"] += max(float(row["today_cost"] or 0), 0.0)
        except (TypeError, ValueError):
            pass
        _merge_daily_components(item, row)
    for item in grouped.values():
        item["costUsd"] = round(item["costUsd"], 6)
    return [grouped[day] for day in reversed(selected_days)]


def delete_device_snapshots(db: Database, device_id: str) -> int:
    cur = db.execute(
        "DELETE FROM tm_snapshot_buckets WHERE device_id = ?", (device_id,)
    )
    return cur.rowcount or 0


# ---------------------------------------------------------------- 旧表迁移


def migrate_legacy_tables(db: Database) -> dict:
    """v1 tm_snapshots → 桶表（一次性）；tm_devices / tm_snapshots 原样保留。"""
    if _meta_get(db, "legacy_migrated"):
        return {"migrated": False, "reason": "already_done"}
    exists = db.fetchone(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tm_snapshots'"
    )
    ported = 0
    if exists:
        rows = db.fetchall("SELECT * FROM tm_snapshots")
        for row in rows:
            received = _parse_iso(row.get("received_at")) or datetime.now(timezone.utc)
            db.execute(
                """
                INSERT OR IGNORE INTO tm_snapshot_buckets (
                    device_id, local_day, bucket_start,
                    today_total, today_output, today_cache_read, today_cache_write,
                    today_unclassified, today_cost,
                    month_total, month_cost, all_time_total, all_time_cost,
                    server_received_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["device_id"], row.get("day") or received.date().isoformat(),
                    bucket_start_of(received),
                    int(row.get("today_total") or 0),
                    int(row.get("today_output") or 0),
                    int(row.get("today_cache_read") or 0),
                    int(row.get("today_cache_write") or 0),
                    int(row.get("today_unclassified") or 0),
                    float(row.get("today_cost") or 0),
                    int(row.get("month_total") or 0), float(row.get("month_cost") or 0),
                    int(row.get("all_time_total") or 0), float(row.get("all_time_cost") or 0),
                    row.get("received_at") or "",
                ),
            )
            ported += 1
    _meta_set(db, "legacy_migrated", "1")
    log.info("旧版 tm 表迁移完成：搬入 %d 条快照（旧表原样保留）", ported)
    return {"migrated": True, "ported_snapshots": ported}


def _legacy_rejected_ids(db: Database) -> set[str]:
    raw = _meta_get(db, "legacy_rejected_devices")
    if not raw:
        return set()
    try:
        data = json.loads(raw)
    except ValueError:
        return set()
    return {str(x) for x in data} if isinstance(data, list) else set()


def mark_legacy_rejected(db: Database, device_id: str) -> None:
    """单个旧设备 payload 被官方确定性拒绝（4xx）时记录，回灌不再重试它。"""
    rejected = _legacy_rejected_ids(db)
    rejected.add(str(device_id))
    _meta_set(db, "legacy_rejected_devices", json.dumps(sorted(rejected)))


def legacy_device_payloads(db: Database) -> list[dict]:
    """待回灌官方 hub 的 v1 设备 payload（一次性，配合 legacy_migrated 标记）。"""
    exists = db.fetchone(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tm_devices'"
    )
    if not exists or _meta_get(db, "legacy_reingested"):
        return []
    rejected = _legacy_rejected_ids(db)
    rows = db.fetchall("SELECT device_id, payload, last_seen_at FROM tm_devices")
    payloads = []
    for row in rows:
        try:
            payload = json.loads(row.get("payload") or "{}")
        except ValueError:
            continue
        device_key = ""
        if isinstance(payload, dict) and payload.get("deviceId"):
            device_key = str(payload["deviceId"])
        elif isinstance(payload, dict) and row.get("device_id"):
            payload.setdefault("deviceId", row["device_id"])
            device_key = str(row["device_id"])
        if not device_key:
            continue
        if device_key in rejected:
            continue
        payloads.append(payload)
    return payloads


def mark_legacy_reingested(db: Database) -> None:
    """仅在全部旧设备 payload 成功回灌 tm-core 后写入幂等标记。"""
    _meta_set(db, "legacy_reingested", "1")
