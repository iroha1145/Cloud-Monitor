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
from typing import Callable, Optional

from .db import Database
from .services import utc_now
from .tm_snapshots import norm_ts, utc_z

log = logging.getLogger("tm-outbox")

MAX_PENDING_DEFAULT = 1000
MAX_ATTEMPTS_DEFAULT = 8
DONE_RETENTION_HOURS = 2
REPLAY_BATCH = 100
DETERMINISTIC_FAILURES = (OverflowError, ValueError, UnicodeEncodeError, TypeError, ArithmeticError)
# 4xx 里仍应重试的状态：限流 / 请求超时 / Too Early。其余 4xx 视为载荷
# 确定性拒绝（mark_rejected，不再重放）。
RETRYABLE_CLIENT_ERRORS = frozenset({408, 425, 429})

SCHEMA = """
CREATE TABLE IF NOT EXISTS tm_ingest_outbox (
    request_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    local_day TEXT NOT NULL DEFAULT '',
    ingest_sequence INTEGER NOT NULL DEFAULT 0,
    snapshot_written INTEGER NOT NULL DEFAULT 0,
    writes_usage INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_outbox_state_time
    ON tm_ingest_outbox(state, received_at);
"""

INDEX_DEVICE_DAY_SEQ = """
CREATE INDEX IF NOT EXISTS idx_outbox_device_day_seq
    ON tm_ingest_outbox(device_id, local_day, ingest_sequence);
"""

_OUTBOX_COLUMNS = (
    ("local_day", "TEXT NOT NULL DEFAULT ''"),
    ("ingest_sequence", "INTEGER NOT NULL DEFAULT 0"),
    ("snapshot_written", "INTEGER NOT NULL DEFAULT 0"),
    ("writes_usage", "INTEGER NOT NULL DEFAULT 1"),
)


def is_retryable_http(status_code: int) -> bool:
    """True = 保留 pending 并重试（5xx 与限流类 4xx）。"""
    return status_code in RETRYABLE_CLIENT_ERRORS or status_code >= 500


class OutboxFullError(Exception):
    """pending 超过上限：背压拒绝，客户端稍后重试。"""


def _as_flag(value: object) -> bool:
    try:
        return int(value or 0) != 0
    except (TypeError, ValueError):
        return bool(value)


def _payload_local_day(payload: dict) -> str:
    from .tm_snapshots import resolve_local_day

    if not isinstance(payload, dict):
        return ""
    windows = payload.get("periodWindows")
    try:
        day, _tz = resolve_local_day(
            period_windows=windows if isinstance(windows, dict) else None,
            updated_at=payload.get("updatedAt"),
            received_at=payload.get("receivedAt"),
        )
    except (OverflowError, ValueError, TypeError):
        return ""
    return day or ""


def _payload_writes_usage(payload: dict) -> int:
    from .tm_validate import is_limits_only_update

    return 0 if is_limits_only_update(payload) else 1


def _next_ingest_sequence(db: Database) -> int:
    row = db.fetchone(
        "SELECT COALESCE(MAX(ingest_sequence), 0) AS n FROM tm_ingest_outbox"
    )
    return int((row or {}).get("n") or 0) + 1


def _backfill_outbox_columns(db: Database) -> None:
    rows = db._conn.execute(
        "SELECT request_id, payload_json, received_at, ingest_sequence, local_day, writes_usage "
        "FROM tm_ingest_outbox ORDER BY received_at ASC, request_id ASC"
    ).fetchall()
    seq = 0
    for row in rows:
        current = int(row["ingest_sequence"] or 0)
        if current > seq:
            seq = current
        updates: list[str] = []
        params: list[object] = []
        if current <= 0:
            seq += 1
            updates.append("ingest_sequence = ?")
            params.append(seq)
        payload: dict = {}
        raw = row["payload_json"]
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = {}
            if isinstance(parsed, dict):
                payload = parsed
        if not str(row["local_day"] or ""):
            day = _payload_local_day(payload)
            if day:
                updates.append("local_day = ?")
                params.append(day)
        if row["writes_usage"] is None or (
            int(row["writes_usage"] or 1) == 1 and payload
        ):
            writes = _payload_writes_usage(payload)
            if writes != int(row["writes_usage"] or 1):
                updates.append("writes_usage = ?")
                params.append(writes)
        if updates:
            params.append(row["request_id"])
            db._conn.execute(
                "UPDATE tm_ingest_outbox SET "
                + ", ".join(updates)
                + " WHERE request_id = ?",
                params,
            )


def ensure_schema(db: Database) -> None:
    with db._lock:
        db._conn.executescript(SCHEMA)
        columns = {
            str(row["name"])
            for row in db._conn.execute("PRAGMA table_info(tm_ingest_outbox)")
        }
        migrated = False
        for name, decl in _OUTBOX_COLUMNS:
            if name not in columns:
                db._conn.execute(f"ALTER TABLE tm_ingest_outbox ADD COLUMN {name} {decl}")
                migrated = True
        if migrated or db._conn.execute(
            "SELECT 1 FROM tm_ingest_outbox WHERE ingest_sequence = 0 LIMIT 1"
        ).fetchone():
            _backfill_outbox_columns(db)
        # 旧库先 ALTER 加列，再建模；否则 CREATE INDEX 会因缺列中止启动。
        db._conn.executescript(INDEX_DEVICE_DAY_SEQ)


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
        pending = replayable_count(db, max_attempts=MAX_ATTEMPTS_DEFAULT)
        if pending >= max_pending:
            raise OutboxFullError(
                f"待重放队列已达上限 {max_pending}（快照层持续失败？）"
            )
        slim = _slim_payload(payload)
        db.execute(
            """
            INSERT INTO tm_ingest_outbox (
                request_id, device_id, payload_json, received_at,
                local_day, ingest_sequence, snapshot_written, writes_usage
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                request_id,
                device_id,
                json.dumps(slim, ensure_ascii=False),
                norm_ts(utc_now()),
                _payload_local_day(payload),
                _next_ingest_sequence(db),
                _payload_writes_usage(payload),
            ),
        )


def mark_done(
    db: Database, request_id: str, *, snapshot_written: Optional[bool] = None
) -> None:
    if snapshot_written is None:
        db.execute(
            "UPDATE tm_ingest_outbox SET state = 'done', last_error = NULL WHERE request_id = ?",
            (request_id,),
        )
        return
    db.execute(
        """
        UPDATE tm_ingest_outbox
        SET state = 'done', last_error = NULL, snapshot_written = ?
        WHERE request_id = ?
        """,
        (1 if snapshot_written else 0, request_id),
    )


def can_supersede(old: dict, saved: dict) -> bool:
    """无需补写必须以已持久化的用量快照为证据。"""
    if not _as_flag(saved.get("snapshot_written")):
        return False
    if str(saved.get("device_id") or "") != str(old.get("device_id") or ""):
        return False
    saved_day = str(saved.get("local_day") or "")
    old_day = str(old.get("local_day") or "")
    if not saved_day or not old_day or saved_day != old_day:
        return False
    if int(saved.get("ingest_sequence") or 0) <= int(old.get("ingest_sequence") or 0):
        return False
    if _as_flag(old.get("writes_usage")) and not _as_flag(saved.get("writes_usage")):
        return False
    return True


def _outbox_identity(db: Database, request_id: str) -> Optional[dict]:
    return db.fetchone(
        """
        SELECT request_id, device_id, local_day, ingest_sequence,
               snapshot_written, writes_usage, received_at
        FROM tm_ingest_outbox WHERE request_id = ?
        """,
        (request_id,),
    )


def supersede_older_pending(db: Database, device_id: str, request_id: str) -> int:
    """只在新行已写入同日用量快照后，才把更早的同日 pending 标 superseded。

    额度-only 或先到请求不得清掉仍需补写的用量行。
    """
    saved = _outbox_identity(db, request_id)
    if not saved or str(saved.get("device_id") or "") != device_id:
        return 0
    if not _as_flag(saved.get("snapshot_written")):
        return 0
    pending = db.fetchall(
        """
        SELECT request_id, device_id, local_day, ingest_sequence,
               snapshot_written, writes_usage
        FROM tm_ingest_outbox
        WHERE device_id = ? AND state = 'pending' AND request_id != ?
        """,
        (device_id, request_id),
    )
    n = 0
    for old in pending:
        if not can_supersede(old, saved):
            continue
        db.execute(
            """
            UPDATE tm_ingest_outbox
            SET state = 'done', last_error = 'superseded_by_newer'
            WHERE request_id = ?
            """,
            (old["request_id"],),
        )
        n += 1
    return n


def reject_exhausted_pending(
    db: Database, *, max_attempts: int = MAX_ATTEMPTS_DEFAULT
) -> int:
    """H-9：升级前 attempts≥上限的 pending 僵尸行一次性转 rejected。"""
    cur = db.execute(
        """
        UPDATE tm_ingest_outbox
        SET state = 'rejected',
            last_error = ?
        WHERE state = 'pending' AND attempts >= ?
        """,
        (f"exceeded {max_attempts} attempts (startup sweep)", max_attempts),
    )
    return cur.rowcount or 0


def mark_failed(
    db: Database,
    request_id: str,
    error: str,
    *,
    max_attempts: int = MAX_ATTEMPTS_DEFAULT,
) -> None:
    db.execute(
        """
        UPDATE tm_ingest_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE request_id = ?
        """,
        (error[:500], request_id),
    )
    row = db.fetchone(
        "SELECT attempts FROM tm_ingest_outbox WHERE request_id = ?",
        (request_id,),
    )
    if row and int(row["attempts"] or 0) >= max_attempts:
        db.execute(
            """
            UPDATE tm_ingest_outbox
            SET state = 'rejected', last_error = ?
            WHERE request_id = ?
            """,
            ((f"exceeded {max_attempts} attempts: {error}")[:500], request_id),
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
    return replayable_count(db)


def replayable_count(db: Database, *, max_attempts: int = MAX_ATTEMPTS_DEFAULT) -> int:
    return int(
        db.fetchone(
            "SELECT COUNT(*) AS n FROM tm_ingest_outbox"
            " WHERE state='pending' AND attempts < ?",
            (max_attempts,),
        )["n"]
    )


def drop_pending(db: Database, request_id: str) -> None:
    db.execute("DELETE FROM tm_ingest_outbox WHERE request_id = ?", (request_id,))


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
            (utc_z(datetime.now(timezone.utc)),),
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


_overview_invalidator: Callable[[], None] | None = None


def set_overview_invalidator(fn: Callable[[], None] | None) -> None:
    global _overview_invalidator
    _overview_invalidator = fn


def _invalidate_overview(_db: Database) -> None:
    if _overview_invalidator is not None:
        _overview_invalidator()


def _fetch_devices_index(core) -> dict[str, dict]:
    """一轮重放只 GET 一次 /api/devices（H-10）。不可达必须抛出（H-3）。"""
    from .tm_proxy import UpstreamUnavailable

    try:
        resp = core.request("GET", "/api/devices")
    except UpstreamUnavailable:
        raise
    except Exception:
        return {}
    if getattr(resp, "status_code", 0) != 200:
        return {}
    try:
        body = resp.json()
    except ValueError:
        return {}
    devices = body.get("devices") if isinstance(body, dict) else None
    if not isinstance(devices, list):
        return {}
    index: dict[str, dict] = {}
    for record in devices:
        if isinstance(record, dict) and record.get("deviceId") is not None:
            index[str(record.get("deviceId"))] = record
    return index


def _current_device_record(
    core, device_id: str, devices_index: Optional[dict[str, dict]] = None
) -> Optional[dict]:
    index = devices_index if devices_index is not None else _fetch_devices_index(core)
    return index.get(device_id)


def _superseded(db: Database, row: dict) -> bool:
    """同设备同日本地日已有更新的用量快照时，无需回灌旧载荷。"""
    device_id = str(row.get("device_id") or "")
    local_day = str(row.get("local_day") or "")
    if not device_id or not local_day:
        return False
    seq = int(row.get("ingest_sequence") or 0)
    writes_usage = 1 if _as_flag(row.get("writes_usage")) else 0
    later = db.fetchone(
        """
        SELECT 1 FROM tm_ingest_outbox
        WHERE device_id = ? AND local_day = ? AND snapshot_written = 1
          AND ingest_sequence > ? AND request_id != ?
          AND (? = 0 OR writes_usage = 1)
        LIMIT 1
        """,
        (device_id, local_day, seq, row["request_id"], writes_usage),
    )
    if later is not None:
        return True
    snap = db.fetchone(
        """
        SELECT 1 FROM tm_snapshot_buckets
        WHERE device_id = ? AND local_day = ? AND server_received_at > ?
        LIMIT 1
        """,
        (device_id, local_day, norm_ts(row.get("received_at"))),
    )
    return snap is not None


def replay_pending(
    db: Database, core, *, max_items: int = REPLAY_BATCH,
    should_stop: Callable[[], bool] | None = None,
) -> dict:
    """重放未完成项。core 为 TmCore；返回统计。返回值含 stopped_by 表示
    因上游不可达提前中止（下轮继续）。"""
    from .tm_proxy import UpstreamUnavailable
    from .tm_snapshots import write_snapshot
    from .tm_validate import is_limits_only_update

    reject_exhausted_pending(db)

    rows = db.fetchall(
        """
        SELECT request_id, device_id, payload_json, received_at,
               local_day, ingest_sequence, snapshot_written, writes_usage
        FROM tm_ingest_outbox
        WHERE state = 'pending' AND attempts < ?
        ORDER BY ingest_sequence ASC, received_at ASC
        LIMIT ?
        """,
        (MAX_ATTEMPTS_DEFAULT, max_items),
    )
    stats = {
        "checked": len(rows),
        "completed": 0,
        "superseded": 0,
        "rejected": 0,
        "failed": 0,
    }
    devices_index: dict[str, dict] | None = None
    for row in rows:
        # Finish the current request/snapshot, then leave untouched items pending.
        if should_stop is not None and should_stop():
            stats["stopped_by"] = "shutdown"
            break
        try:
            payload = json.loads(row["payload_json"])
        except ValueError:
            mark_rejected(db, row["request_id"], "stored payload is not JSON")
            stats["rejected"] += 1
            continue
        if _superseded(db, row):
            mark_done(db, row["request_id"])
            stats["superseded"] += 1
            continue
        try:
            # G-04 / H-10：重放只读当前设备记录写快照；每轮缓存一次设备表。
            if devices_index is None:
                devices_index = _fetch_devices_index(core)
            record = _current_device_record(core, row["device_id"], devices_index)
            if record is None:
                mark_failed(
                    db, row["request_id"],
                    f"tm-core missing normalized device {row['device_id']!r}",
                )
                stats["failed"] += 1
                continue
            with db.transaction():
                written = write_snapshot(
                    db,
                    device_id=row["device_id"],
                    record=record or {},
                    incoming=payload,
                    limits_only=is_limits_only_update(payload),
                    force_received_at=row["received_at"],
                )
                mark_done(
                    db, row["request_id"], snapshot_written=written is not None
                )
                if written is not None:
                    supersede_older_pending(db, row["device_id"], row["request_id"])
            set_snapshot_status(db, success=True)
            stats["completed"] += 1
            _invalidate_overview(db)
        except UpstreamUnavailable as exc:
            log.warning("重放中止（tm-core 不可达）: %s", exc)
            stats["stopped_by"] = "upstream_unavailable"
            break
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, DETERMINISTIC_FAILURES):
                mark_rejected(db, row["request_id"], str(exc))
                stats["rejected"] += 1
            else:
                if "不可达" in str(exc) or exc.__class__.__name__ in {
                    "UpstreamUnavailable", "ConnectError", "ConnectTimeout",
                }:
                    log.warning("重放中止（tm-core 不可达）: %s", exc)
                    stats["stopped_by"] = "upstream_unavailable"
                    break
                mark_failed(db, row["request_id"], str(exc))
                stats["failed"] += 1
            set_snapshot_status(db, success=False, error=str(exc))
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
