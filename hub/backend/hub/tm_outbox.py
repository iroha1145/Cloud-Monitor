"""事务发件箱：保证 tm-core 已接收的数据不会在快照层静默丢失。

协议（P0-1）:
1. 转发 tm-core 之前，先在 SQLite 记录 pending（与后续快照写入解耦）。
2. tm-core 返回 200 后，直接从该次 ingest 响应的 stats.devices 取规范化
   记录写快照（不再额外 GET /api/devices），并把 outbox 标记 done——两者
   在同一 SQLite 事务边界内完成。
3. 快照失败：outbox 记为 pending(attempts++, last_error)，响应仍是官方
   200（数据已持久化于官方 devices.json），由重放保证最终一致；健康接口
   暴露 snapshot_degraded。
4. 重放（启动时 + 后台周期）：
   - 已被更新数据超越的 pending（该设备存在 server_received_at 更新的桶）
     直接标 done，不回灌旧载荷（避免官方记录回退）；
   - 否则重放载荷到 tm-core（官方 merge 幂等）并写快照；
   - 上游不可达时中止本轮重放，下轮再试。
5. pending 数量上限（默认 1000）触发背压：新 ingest 拒绝为 503；
   done 记录保留 DONE_RETENTION_HOURS（2 小时）后清理。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from .db import Database
from .services import utc_now
from .tm_snapshots import norm_ts, utc_z

log = logging.getLogger("tm-outbox")

MAX_PENDING_DEFAULT = 1000
DONE_RETENTION_HOURS = 2
REPLAY_BATCH = 100

SCHEMA = """
CREATE TABLE IF NOT EXISTS tm_ingest_outbox (
    request_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_state_time
    ON tm_ingest_outbox(state, received_at);
"""


class OutboxFullError(Exception):
    """pending 超过上限：背压拒绝，客户端稍后重试。"""


def ensure_schema(db: Database) -> None:
    with db._lock:
        db._conn.executescript(SCHEMA)


def new_request_id() -> str:
    return uuid.uuid4().hex


def _slim_payload(payload: dict) -> dict:
    """Strip month.sessions before outbox storage (~93% of payload volume).

    month.sessions is a point-in-time snapshot of all billing-month sessions
    that goes stale in seconds.  Replaying an old snapshot has no value; the
    next successful ingest brings current data.  Keeping it inflates the
    database by ~1 MB per record (×6/min in real-time mode → ~360 MB/hour).
    """
    month = payload.get("month")
    if isinstance(month, dict) and "sessions" in month:
        return {**payload, "month": {k: v for k, v in month.items() if k != "sessions"}}
    return payload


def record_pending(
    db: Database,
    *,
    request_id: str,
    device_id: str,
    payload: dict,
    max_pending: int = MAX_PENDING_DEFAULT,
) -> None:
    with db.transaction():
        pending = int(
            db.fetchone(
                "SELECT COUNT(*) AS n FROM tm_ingest_outbox WHERE state = 'pending'"
            )["n"]
        )
        if pending >= max_pending:
            raise OutboxFullError(
                f"待重放队列已达上限 {max_pending}（快照层持续失败？）"
            )
        db.execute(
            """
            INSERT INTO tm_ingest_outbox (request_id, device_id, payload_json, received_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                request_id,
                device_id,
                json.dumps(_slim_payload(payload), ensure_ascii=False),
                norm_ts(utc_now()),
            ),
        )


def mark_done(db: Database, request_id: str) -> None:
    db.execute(
        "UPDATE tm_ingest_outbox SET state = 'done', last_error = NULL WHERE request_id = ?",
        (request_id,),
    )


def mark_failed(db: Database, request_id: str, error: str) -> None:
    db.execute(
        """
        UPDATE tm_ingest_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE request_id = ?
        """,
        (error[:500], request_id),
    )


def mark_rejected(db: Database, request_id: str, error: str) -> None:
    """上游确定性 4xx：停止重放，保留短期审计记录。"""
    db.execute(
        """
        UPDATE tm_ingest_outbox
        SET state = 'rejected', attempts = attempts + 1, last_error = ?
        WHERE request_id = ?
        """,
        (error[:500], request_id),
    )


def purge_device(db: Database, device_id: str) -> int:
    """设备删除时清空其全部 outbox 行：残留 pending 会在下轮重放时
    把刚删除的设备重新灌回 tm-core（复活）。"""
    cur = db.execute(
        "DELETE FROM tm_ingest_outbox WHERE device_id = ?", (device_id,)
    )
    return cur.rowcount or 0


def pending_count(db: Database) -> int:
    return int(
        db.fetchone("SELECT COUNT(*) AS n FROM tm_ingest_outbox WHERE state='pending'")["n"]
    )


def prune_done(db: Database, *, retention_hours: int = DONE_RETENTION_HOURS) -> int:
    cutoff = utc_z(datetime.now(timezone.utc) - timedelta(hours=retention_hours))
    cur = db.execute(
        "DELETE FROM tm_ingest_outbox"
        " WHERE state IN ('done','rejected') AND received_at < ?",
        (cutoff,),
    )
    return cur.rowcount or 0


def set_snapshot_status(db: Database, *, success: bool, error: Optional[str] = None) -> None:
    if success:
        db.execute(
            "INSERT INTO tm_meta (key, value) VALUES ('last_snapshot_success_at', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (utc_now(),),
        )
        db.execute(
            "INSERT INTO tm_meta (key, value) VALUES ('last_snapshot_error', '')"
            " ON CONFLICT(key) DO UPDATE SET value = ''",
        )
    else:
        db.execute(
            "INSERT INTO tm_meta (key, value) VALUES ('last_snapshot_error', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ((error or "unknown")[:500],),
        )


def snapshot_health(db: Database) -> dict:
    def meta(key: str) -> Optional[str]:
        row = db.fetchone("SELECT value FROM tm_meta WHERE key = ?", (key,))
        value = row["value"] if row else None
        return value or None

    last_success = meta("last_snapshot_success_at")
    last_error = meta("last_snapshot_error")
    pending = pending_count(db)
    return {
        "pending_outbox": pending,
        "last_snapshot_success_at": last_success,
        "last_snapshot_error": last_error,
        "snapshot_degraded": pending > 0 or (last_success is None and last_error is not None),
    }


def _superseded(db: Database, device_id: str, received_at: str) -> bool:
    """该设备已有比 pending 项更新的快照桶：无需回灌旧载荷。"""
    row = db.fetchone(
        """
        SELECT 1 FROM tm_snapshot_buckets
        WHERE device_id = ? AND server_received_at > ?
        LIMIT 1
        """,
        (device_id, norm_ts(received_at)),
    )
    return row is not None


def replay_pending(db: Database, core, *, max_items: int = REPLAY_BATCH) -> dict:
    """重放未完成项。core 为 TmCore；返回统计。返回值含 stopped_by 表示
    因上游不可达提前中止（下轮继续）。"""
    from .tm_snapshots import write_snapshot
    from .tm_validate import is_limits_only_update

    rows = db.fetchall(
        """
        SELECT request_id, device_id, payload_json, received_at
        FROM tm_ingest_outbox WHERE state = 'pending'
        ORDER BY received_at ASC LIMIT ?
        """,
        (max_items,),
    )
    stats = {
        "checked": len(rows),
        "completed": 0,
        "superseded": 0,
        "rejected": 0,
        "failed": 0,
    }
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except ValueError:
            mark_rejected(db, row["request_id"], "stored payload is not JSON")
            stats["rejected"] += 1
            continue
        if _superseded(db, row["device_id"], row["received_at"]):
            mark_done(db, row["request_id"])
            stats["superseded"] += 1
            continue
        try:
            resp = core.request("POST", "/api/ingest", json_body=payload)
        except Exception as exc:  # 上游不可达：中止本轮
            log.warning("重放中止（tm-core 不可达）: %s", exc)
            stats["stopped_by"] = "upstream_unavailable"
            break
        if resp.status_code != 200:
            if 400 <= resp.status_code < 500:
                mark_rejected(
                    db, row["request_id"], f"upstream HTTP {resp.status_code}"
                )
                stats["rejected"] += 1
                continue
            mark_failed(db, row["request_id"], f"upstream HTTP {resp.status_code}")
            stats["failed"] += 1
            stats["stopped_by"] = f"upstream_status_{resp.status_code}"
            break
        try:
            body = resp.json()
            record = next(
                (
                    r
                    for r in (body.get("stats") or {}).get("devices") or []
                    if str(r.get("deviceId")) == row["device_id"]
                ),
                None,
            )
            if record is None:
                raise ValueError(
                    "tm-core ingest response missing normalized device "
                    f"{row['device_id']!r}"
                )
            write_snapshot(
                db,
                device_id=row["device_id"],
                record=record or {},
                incoming=payload,
                limits_only=is_limits_only_update(payload),
                force_received_at=row["received_at"],
            )
            mark_done(db, row["request_id"])
            set_snapshot_status(db, success=True)
            stats["completed"] += 1
        except Exception as exc:  # noqa: BLE001
            mark_failed(db, row["request_id"], str(exc))
            set_snapshot_status(db, success=False, error=str(exc))
            stats["failed"] += 1
    # 无条件清理：健康路径下 pending 恒空（ingest 即插即 done），若只在
    # 处理过 pending 后才清，done/rejected 的保留策略就是死代码，库无限增长
    pruned = prune_done(db)
    if pruned:
        try:
            db.execute("PRAGMA incremental_vacuum(500)")
        except Exception:  # noqa: BLE001
            pass
    try:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:  # noqa: BLE001
        pass
    return stats
