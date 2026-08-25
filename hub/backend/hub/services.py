"""设备同步写入与聚合查询。

写路径: apply_sync_push 在单个 BEGIN IMMEDIATE 事务内完成
device/users/records 三类写入，任何异常整体回滚。
读路径: /records 走 SQL LIMIT/OFFSET 分页，/usage 走 SQL GROUP BY 聚合，
返回结构与 openwebui-monitor 保持兼容（前端零改动）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .db import Database, record_fingerprint
from .models import DeviceInfo, RecordIn, SyncPushRequest, UserIn


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


def validate_time_range(start: Optional[str], end: Optional[str]) -> None:
    start_dt = parse_time(start, end_of_day=False)
    end_dt = parse_time(end, end_of_day=True)
    if start_dt is not None and end_dt is not None and start_dt > end_dt:
        raise ValueError("start_time 不能晚于 end_time")


# ---------------------------------------------------------------- 写入（同步）


def _upsert_device(db: Database, device: DeviceInfo, *, now: str) -> None:
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
        (device.id, device.name, device.platform, device.agent_version, now, now),
    )


def _upsert_user(db: Database, user: UserIn, *, now: str) -> None:
    """首次插入保留本地 created_at；更新不覆盖原始 created_at。
    空字段不覆盖已存值（与 _upsert_device 同一保留语义）：心跳等部分
    载荷带空 email/name 时不得把已同步的身份信息抹成空串。"""
    stamp = now
    created = user.created_at or stamp
    updated = user.updated_at or stamp
    db.execute(
        """
        INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            email = CASE WHEN excluded.email != '' THEN excluded.email ELSE users.email END,
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
            role = CASE WHEN excluded.role != '' THEN excluded.role ELSE users.role END,
            updated_at = excluded.updated_at
        """,
        (user.id, user.email, user.name, user.role, created, updated),
    )


def apply_sync_push(
    db: Database,
    payload: SyncPushRequest,
    *,
    protocol_version: int,
) -> dict:
    """幂等推送：按 (device_id, source_instance_id, local_id) 去重。

    内容指纹一致的重复推送计 duplicates；同一主键但内容不同计 conflicts
    （保留云端已有数据，不覆盖）。conflicts > 0 时 agent 不得推进游标。
    """
    now = utc_now()
    source = payload.source_instance_id
    records = payload.records

    with db.transaction():
        _upsert_device(db, payload.device, now=now)
        for user in payload.users:
            _upsert_user(db, user, now=now)

        inserted = 0
        duplicates = 0
        conflicts = 0
        if records:
            local_ids = [r.local_id for r in records]
            placeholders = ",".join("?" * len(local_ids))
            existing = {
                row["local_id"]: row["fingerprint"]
                for row in db.fetchall(
                    f"""
                    SELECT local_id, fingerprint FROM usage_records
                    WHERE device_id = ? AND source_instance_id = ?
                      AND local_id IN ({placeholders})
                    """,
                    [payload.device.id, source, *local_ids],
                )
            }
            to_insert: list[tuple[Any, ...]] = []
            seen_batch: dict[int, str] = {}
            for record in records:
                fingerprint = record_fingerprint(
                    user_id=record.user_id,
                    nickname=record.nickname,
                    model_name=record.model_name,
                    input_tokens=record.input_tokens,
                    output_tokens=record.output_tokens,
                    created_at=record.created_at,
                )
                if record.local_id in existing:
                    if existing[record.local_id] == fingerprint:
                        duplicates += 1
                    else:
                        conflicts += 1
                    continue
                # 同批内重复 local_id：不入列（否则 executemany 撞唯一索引
                # 抛未捕获 IntegrityError → 整批 500 → agent 重试同批死循环），
                # 分类语义与数据库侧去重一致
                if record.local_id in seen_batch:
                    if seen_batch[record.local_id] == fingerprint:
                        duplicates += 1
                    else:
                        conflicts += 1
                    continue
                seen_batch[record.local_id] = fingerprint
                to_insert.append(
                    (
                        payload.device.id,
                        source,
                        record.local_id,
                        record.user_id,
                        record.nickname,
                        record.model_name,
                        record.input_tokens,
                        record.output_tokens,
                        record.created_at,
                        fingerprint,
                    )
                )
            if to_insert:
                db.executemany(
                    """
                    INSERT INTO usage_records (
                        device_id, source_instance_id, local_id, user_id,
                        nickname, model_name, input_tokens, output_tokens,
                        created_at, fingerprint
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    to_insert,
                )
                inserted = len(to_insert)

    return {
        "success": True,
        "protocol_version": protocol_version,
        "device_id": payload.device.id,
        "source_instance_id": source,
        "received": len(records),
        "inserted": inserted,
        "duplicates": duplicates,
        "conflicts": conflicts,
        "users_upserted": len(payload.users),
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


def _filters_clause(
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    user_id: Optional[str] = None,
    model_name: Optional[str] = None,
    device_id: Optional[str] = None,
    alias: str = "",
) -> tuple[str, list]:
    """构造 WHERE 片段；alias="r" 时给列名加表别名前缀（聚合查询用）。"""
    a = f"{alias}." if alias else ""
    clauses: list[str] = []
    params: list[Any] = []
    start_dt = parse_time(start_time, end_of_day=False)
    end_dt = parse_time(end_time, end_of_day=True)
    if start_dt is not None:
        clauses.append(f"{a}created_at >= ?")
        params.append(_iso(start_dt))
    if end_dt is not None:
        clauses.append(f"{a}created_at <= ?")
        params.append(_iso(end_dt))
    if user_id:
        clauses.append(f"{a}user_id = ?")
        params.append(user_id)
    if model_name:
        clauses.append(f"{a}model_name = ?")
        params.append(model_name)
    if device_id:
        clauses.append(f"{a}device_id = ?")
        params.append(device_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def list_usage_page(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    user_id: Optional[str] = None,
    model_name: Optional[str] = None,
    device_id: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """SQL 分页：COUNT 计总数，LIMIT/OFFSET 取当前页，不整表加载。"""
    validate_time_range(start_time, end_time)
    page = max(int(page), 1)
    page_size = min(max(int(page_size), 1), 200)
    where, params = _filters_clause(
        start_time=start_time,
        end_time=end_time,
        user_id=user_id,
        model_name=model_name,
        device_id=device_id,
    )
    total = int(
        db.fetchone(f"SELECT COUNT(*) AS n FROM usage_records {where}", params)["n"]
    )
    offset = (page - 1) * page_size
    rows = db.fetchall(
        f"""
        SELECT * FROM usage_records {where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, offset],
    )
    return {
        "records": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


_NICKNAME_SQL = """
    COALESCE(
        NULLIF(u.name, ''),
        (SELECT r2.nickname FROM usage_records r2
          WHERE r2.user_id = r.user_id AND r2.nickname <> ''
          ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1),
        MAX(r.nickname)
    ) AS nickname
"""


def usage_report(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    device_id: Optional[str] = None,
) -> dict:
    """SQL 聚合：totals / by_user / by_model / by_device / time_range。

    by_user 的昵称取「用户表当前名字」，为空时回退到该用户最新一条
    非空记录昵称，不再出现倒序遍历留下最旧昵称的问题。
    """
    validate_time_range(start_time, end_time)
    where, params = _filters_clause(
        start_time=start_time, end_time=end_time, device_id=device_id
    )

    totals_row = db.fetchone(
        f"""
        SELECT COUNT(*) AS calls,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COUNT(DISTINCT user_id) AS distinct_users,
               COUNT(DISTINCT model_name) AS distinct_models,
               MIN(created_at) AS min_at,
               MAX(created_at) AS max_at
        FROM usage_records {where}
        """,
        params,
    )
    input_tokens = int(totals_row["input_tokens"] or 0)
    output_tokens = int(totals_row["output_tokens"] or 0)

    rwhere, rparams = _filters_clause(
        start_time=start_time,
        end_time=end_time,
        device_id=device_id,
        alias="r",
    )
    by_user = db.fetchall(
        f"""
        SELECT r.user_id,
               {_NICKNAME_SQL},
               COUNT(*) AS calls,
               COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
               COALESCE(SUM(r.output_tokens), 0) AS output_tokens
        FROM usage_records r LEFT JOIN users u ON u.id = r.user_id
        {rwhere}
        GROUP BY r.user_id
        ORDER BY (COALESCE(SUM(r.input_tokens), 0) + COALESCE(SUM(r.output_tokens), 0)) DESC,
                 r.user_id ASC
        """,
        rparams,
    )
    for row in by_user:
        row["calls"] = int(row["calls"] or 0)
        row["input_tokens"] = int(row["input_tokens"] or 0)
        row["output_tokens"] = int(row["output_tokens"] or 0)
        row["total_tokens"] = row["input_tokens"] + row["output_tokens"]

    by_model = _group_by(db, "model_name", start_time, end_time, device_id)
    by_device = _group_by(db, "device_id", start_time, end_time, device_id)

    return {
        "totals": {
            "calls": int(totals_row["calls"] or 0),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "distinct_users": int(totals_row["distinct_users"] or 0),
            "distinct_models": int(totals_row["distinct_models"] or 0),
        },
        "by_user": by_user,
        "by_model": by_model,
        "by_device": by_device,
        "time_range": {"min": totals_row["min_at"], "max": totals_row["max_at"]},
    }


def _group_by(
    db: Database,
    column: str,
    start_time: Optional[str],
    end_time: Optional[str],
    device_id: Optional[str],
) -> list[dict]:
    where, params = _filters_clause(
        start_time=start_time,
        end_time=end_time,
        device_id=device_id,
        alias="r",
    )
    rows = db.fetchall(
        f"""
        SELECT r.{column} AS {column},
               COUNT(*) AS calls,
               COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
               COALESCE(SUM(r.output_tokens), 0) AS output_tokens
        FROM usage_records r
        {where}
        GROUP BY r.{column}
        ORDER BY (COALESCE(SUM(r.input_tokens), 0) + COALESCE(SUM(r.output_tokens), 0)) DESC,
                 r.{column} ASC
        """,
        params,
    )
    for row in rows:
        row["calls"] = int(row["calls"] or 0)
        row["input_tokens"] = int(row["input_tokens"] or 0)
        row["output_tokens"] = int(row["output_tokens"] or 0)
        row["total_tokens"] = row["input_tokens"] + row["output_tokens"]
    return rows


def list_users(
    db: Database,
    *,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> list[dict]:
    validate_time_range(start_time, end_time)
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
