"""设备同步写入与聚合查询，读接口返回结构与本地 openwebui-monitor 完全一致。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .db import Database


MAX_DEVICE_ID_LENGTH = 128


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_time(value: Optional[str], *, end_of_day: bool = False) -> Optional[datetime]:
    if not value:
        return None
    raw = value.strip()
    if len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
        raw = raw + ("T23:59:59+00:00" if end_of_day else "T00:00:00+00:00")
    raw = raw.replace("Z", "+00:00")
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def normalize_created_at(value: Any) -> str:
    """同步记录的时间戳：接受 ISO 字符串，非法或缺失时用服务器当前时间。"""
    if isinstance(value, str) and value.strip():
        try:
            return _iso(parse_time(value) or datetime.now(timezone.utc))
        except ValueError:
            pass
    return utc_now()


# ---------------------------------------------------------------- 写入（同步）


def upsert_device(
    db: Database,
    device_id: str,
    *,
    name: str = "",
    platform: str = "",
    agent_version: str = "",
    now: Optional[str] = None,
) -> None:
    stamp = now or utc_now()
    db.execute(
        """
        INSERT INTO devices (id, name, platform, agent_version, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE devices.name END,
            platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE devices.platform END,
            agent_version = CASE WHEN excluded.agent_version != '' THEN excluded.agent_version ELSE devices.agent_version END,
            last_seen_at = excluded.last_seen_at
        """,
        (device_id, name or "", platform or "", agent_version or "", stamp, stamp),
    )


def upsert_user(db: Database, user: dict, *, now: Optional[str] = None) -> None:
    if not isinstance(user, dict) or not user.get("id"):
        raise ValueError("缺少用户 id")
    stamp = now or utc_now()
    db.execute(
        """
        INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            role = excluded.role,
            updated_at = excluded.updated_at
        """,
        (
            str(user["id"]),
            str(user.get("email") or ""),
            str(user.get("name") or ""),
            str(user.get("role") or "user"),
            stamp,
            stamp,
        ),
    )


def normalize_push_payload(
    payload: Any, *, max_records: int
) -> tuple[dict, list[dict], list[dict]]:
    """校验并规整 /api/v1/sync/push 请求体，返回 (device, users, records)。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体无效")

    device = payload.get("device") if isinstance(payload.get("device"), dict) else {}
    device_id = str(device.get("id") or "").strip()
    if not device_id or len(device_id) > MAX_DEVICE_ID_LENGTH:
        raise ValueError("缺少有效的 device.id")

    raw_users = payload.get("users")
    if raw_users is None:
        raw_users = []
    if not isinstance(raw_users, list) or len(raw_users) > max_records:
        raise ValueError("users 必须是不超过上限的数组")
    users: list[dict] = []
    for user in raw_users:
        if not isinstance(user, dict) or not user.get("id"):
            raise ValueError("users 中存在缺少 id 的条目")
        users.append(user)

    raw_records = payload.get("records")
    if raw_records is None:
        raw_records = []
    if not isinstance(raw_records, list) or len(raw_records) > max_records:
        raise ValueError(f"records 单次最多 {max_records} 条")
    records: list[dict] = []
    for record in raw_records:
        if not isinstance(record, dict):
            raise ValueError("records 中存在非法条目")
        try:
            local_id = int(record.get("local_id"))
        except (TypeError, ValueError) as exc:
            raise ValueError("record 缺少数字型 local_id") from exc
        if local_id < 1:
            raise ValueError("record.local_id 必须为正整数")
        user_id = record.get("user_id")
        if not user_id or not isinstance(user_id, str):
            raise ValueError("record 缺少 user_id")
        try:
            input_tokens = max(int(record.get("input_tokens") or 0), 0)
            output_tokens = max(int(record.get("output_tokens") or 0), 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("record token 数值无效") from exc
        records.append(
            {
                "local_id": local_id,
                "user_id": user_id,
                "nickname": str(record.get("nickname") or ""),
                "model_name": str(record.get("model_name") or ""),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "created_at": normalize_created_at(record.get("created_at")),
            }
        )

    normalized_device = {
        "id": device_id,
        "name": str(device.get("name") or ""),
        "platform": str(device.get("platform") or ""),
        "agent_version": str(device.get("agent_version") or ""),
    }
    return normalized_device, users, records


def apply_sync_push(
    db: Database, payload: dict, *, max_records: int
) -> dict:
    device, users, records = normalize_push_payload(payload, max_records=max_records)
    now = utc_now()

    upsert_device(
        db,
        device["id"],
        name=device["name"],
        platform=device["platform"],
        agent_version=device["agent_version"],
        now=now,
    )
    for user in users:
        upsert_user(db, user, now=now)

    inserted = 0
    if records:
        cur = db.executemany(
            """
            INSERT OR IGNORE INTO usage_records (
                device_id, local_id, user_id, nickname, model_name,
                input_tokens, output_tokens, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    device["id"],
                    r["local_id"],
                    r["user_id"],
                    r["nickname"],
                    r["model_name"],
                    r["input_tokens"],
                    r["output_tokens"],
                    r["created_at"],
                )
                for r in records
            ],
        )
        inserted = cur.rowcount if cur.rowcount is not None else 0
    return {
        "success": True,
        "device_id": device["id"],
        "users_upserted": len(users),
        "inserted": inserted,
        "skipped": len(records) - max(inserted, 0),
        "server_time": now,
    }


# ---------------------------------------------------------------- 读取（查询）


def _time_clause(
    start: Optional[str], end: Optional[str], *, column: str = "created_at"
) -> tuple[str, list]:
    clauses: list[str] = []
    params: list[Any] = []
    start_dt = parse_time(start, end_of_day=False)
    end_dt = parse_time(end, end_of_day=True)
    if start_dt is not None:
        clauses.append(f"{column} >= ?")
        params.append(_iso(start_dt))
    if end_dt is not None:
        clauses.append(f"{column} <= ?")
        params.append(_iso(end_dt))
    sql = (" AND ".join(clauses)) if clauses else ""
    return sql, params


def list_usage_records(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    user_id: Optional[str] = None,
    model_name: Optional[str] = None,
    device_id: Optional[str] = None,
) -> list[dict]:
    clauses: list[str] = []
    params: list[Any] = []
    time_sql, time_params = _time_clause(start_time, end_time)
    if time_sql:
        clauses.append(time_sql)
        params.extend(time_params)
    if user_id:
        clauses.append("user_id = ?")
        params.append(user_id)
    if model_name:
        clauses.append("model_name = ?")
        params.append(model_name)
    if device_id:
        clauses.append("device_id = ?")
        params.append(device_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return db.fetchall(
        f"SELECT * FROM usage_records {where} ORDER BY created_at DESC, id DESC",
        params,
    )


def paginate_records(
    records: list[dict], *, page: int = 1, page_size: int = 20
) -> dict:
    page = max(int(page), 1)
    page_size = min(max(int(page_size), 1), 200)
    total = len(records)
    start = (page - 1) * page_size
    slice_ = records[start : start + page_size]
    return {
        "records": slice_,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def summarize_records(records: list[dict]) -> dict:
    """与本地 monitor 的汇总结构一致，额外附带 by_device 维度。"""
    calls = len(records)
    input_tokens = sum(int(r.get("input_tokens") or 0) for r in records)
    output_tokens = sum(int(r.get("output_tokens") or 0) for r in records)
    user_ids = {r.get("user_id") for r in records}
    models = {r.get("model_name") for r in records}

    by_user: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    by_device: dict[str, dict] = {}
    for record in records:
        uid = record.get("user_id") or ""
        user_slot = by_user.setdefault(
            uid,
            {
                "user_id": uid,
                "nickname": record.get("nickname") or "",
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            },
        )
        user_slot["calls"] += 1
        user_slot["input_tokens"] += int(record.get("input_tokens") or 0)
        user_slot["output_tokens"] += int(record.get("output_tokens") or 0)
        user_slot["nickname"] = record.get("nickname") or user_slot["nickname"]
        user_slot["total_tokens"] = (
            user_slot["input_tokens"] + user_slot["output_tokens"]
        )

        model = record.get("model_name") or ""
        model_slot = by_model.setdefault(
            model,
            {
                "model_name": model,
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            },
        )
        model_slot["calls"] += 1
        model_slot["input_tokens"] += int(record.get("input_tokens") or 0)
        model_slot["output_tokens"] += int(record.get("output_tokens") or 0)
        model_slot["total_tokens"] = (
            model_slot["input_tokens"] + model_slot["output_tokens"]
        )

        device = record.get("device_id") or ""
        device_slot = by_device.setdefault(
            device,
            {
                "device_id": device,
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            },
        )
        device_slot["calls"] += 1
        device_slot["input_tokens"] += int(record.get("input_tokens") or 0)
        device_slot["output_tokens"] += int(record.get("output_tokens") or 0)
        device_slot["total_tokens"] = (
            device_slot["input_tokens"] + device_slot["output_tokens"]
        )

    stamps = [r.get("created_at") for r in records if r.get("created_at")]
    return {
        "totals": {
            "calls": calls,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "distinct_users": len(user_ids),
            "distinct_models": len(models),
        },
        "by_user": sorted(
            by_user.values(),
            key=lambda item: (-item["total_tokens"], item["user_id"]),
        ),
        "by_model": sorted(
            by_model.values(),
            key=lambda item: (-item["total_tokens"], item["model_name"]),
        ),
        "by_device": sorted(
            by_device.values(),
            key=lambda item: (-item["total_tokens"], item["device_id"]),
        ),
        "time_range": {
            "min": min(stamps) if stamps else None,
            "max": max(stamps) if stamps else None,
        },
    }


def usage_report(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    device_id: Optional[str] = None,
) -> dict:
    records = list_usage_records(
        db, start_time=start_time, end_time=end_time, device_id=device_id
    )
    return summarize_records(records)


def list_users(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> list[dict]:
    time_sql, time_params = _time_clause(start_time, end_time, column="r.created_at")
    join_extra = f"AND {time_sql}" if time_sql else ""
    rows = db.fetchall(
        f"""
        SELECT
            u.id,
            u.email,
            u.name,
            u.role,
            u.created_at,
            u.updated_at,
            COUNT(r.id) AS calls,
            COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(r.output_tokens), 0) AS output_tokens
        FROM users u
        LEFT JOIN usage_records r
            ON r.user_id = u.id
            {join_extra}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        """,
        time_params,
    )
    for row in rows:
        row["calls"] = int(row["calls"] or 0)
        row["input_tokens"] = int(row["input_tokens"] or 0)
        row["output_tokens"] = int(row["output_tokens"] or 0)
        row["total_tokens"] = row["input_tokens"] + row["output_tokens"]
    return rows


def list_devices(db: Database) -> list[dict]:
    rows = db.fetchall(
        """
        SELECT
            d.id,
            d.name,
            d.platform,
            d.agent_version,
            d.first_seen_at,
            d.last_seen_at,
            COUNT(r.id) AS record_count,
            COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
            MAX(r.created_at) AS latest_record_at
        FROM devices d
        LEFT JOIN usage_records r ON r.device_id = d.id
        GROUP BY d.id
        ORDER BY d.last_seen_at DESC
        """
    )
    for row in rows:
        row["record_count"] = int(row["record_count"] or 0)
        row["input_tokens"] = int(row["input_tokens"] or 0)
        row["output_tokens"] = int(row["output_tokens"] or 0)
        row["total_tokens"] = row["input_tokens"] + row["output_tokens"]
    return rows
