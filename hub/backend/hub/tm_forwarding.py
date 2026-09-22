"""Bounded, per-device ordered delivery of validated ingest requests.

Only rows carrying a complete forward_payload_json are eligible. Legacy raw
outbox records are never sent to tm-core. The payload is released atomically
with its own normalized acknowledgement, before local-only snapshot replay.

The deployment runs one worker. Non-blocking device ownership covers foreground
delivery, background retry and deletion; its registry contains active owners
only and has a fixed upper bound. Persisted order survives worker restarts.
"""
from __future__ import annotations

import json
import hashlib
import logging
import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Callable

import httpx

from .db import Database
from . import tm_outbox as outbox
from .services import iso_to_utc
from .tm_snapshots import resolve_local_day, utc_z, write_snapshot
from .tm_validate import is_limits_only_update, validate_ingest_payload

log = logging.getLogger("tm-forwarding")

MAX_FORWARD_BYTES = 16 * 1024 * 1024
MAX_CORE_BODY_BYTES = 1024 * 1024
FORWARD_TTL_SECONDS = 60 * 60
MAX_FORWARD_ATTEMPTS = 8
RETRY_BASE_SECONDS = 5
RETRY_MAX_SECONDS = 5 * 60
# A worker can die after sending the body but before persisting its response.
# Let that bounded upstream call settle before a restarted worker sends again.
INFLIGHT_GRACE_SECONDS = outbox.UNCONFIRMED_GRACE_SECONDS
MAX_ACTIVE_DEVICES = 128


class DeviceDeletingError(Exception):
    """No new row may appear between a device DELETE and its local purge."""


@dataclass
class ForwardAttempt:
    request_id: str | None = None
    response: httpx.Response | None = None
    error_code: str = "upstream_queued"
    message: str = "上报已暂存，等待重新发送"
    retry_after: int = RETRY_BASE_SECONDS


def _parse_stamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value or value != value.strip():
        # 共享解析会 strip；这里保持旧行为：首尾空白视为无法解析，
        # 避免把带空格的 endsAt 当成有效窗口。
        return None
    try:
        return iso_to_utc(value)
    except (ValueError, TypeError, OverflowError):
        return None


def retry_after_seconds(value: str | None, now: datetime) -> float | None:
    """Accept either RFC Retry-After form without retrying earlier than requested."""
    if not value:
        return None
    try:
        delay = float(value)
    except (ValueError, TypeError):
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            delay = (parsed - now).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    if not math.isfinite(delay):
        return None
    # An instruction beyond the queue's lifetime leads to expiry, not early retry.
    return min(max(0.0, delay), FORWARD_TTL_SECONDS + 1)


def _receipt_day(payload: dict, moment: datetime) -> str:
    windows = payload.get("periodWindows")
    windows = windows if isinstance(windows, dict) else {}
    day, _ = resolve_local_day(
        period_windows={"timeZone": windows.get("timeZone")},
        updated_at=utc_z(moment), received_at=utc_z(moment),
    )
    return day


def _explicit_core_day(payload: dict) -> bool:
    windows = payload.get("periodWindows")
    if not isinstance(windows, dict):
        return False
    today = windows.get("today")
    if not isinstance(today, dict):
        return False
    # The official core discards windows without a valid endsAt. A key alone
    # cannot make an otherwise unstamped, delayed request safe across midnight.
    return bool(today.get("key") and _parse_stamp(today.get("endsAt")))


def _serialized(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class ForwardingQueue:
    def __init__(
        self, db: Database, *, max_pending: int = outbox.MAX_PENDING_DEFAULT,
        max_bytes: int = MAX_FORWARD_BYTES, clock: Callable[[], datetime] | None = None,
    ):
        self.db = db
        self.max_pending = max_pending
        self.max_bytes = max_bytes
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._guard = threading.RLock()
        self._active: dict[str, str] = {}

    @contextmanager
    def device_operation(self, device_id: str, operation: str = "forward"):
        """Acquire without parking a web worker behind another network request."""
        with self._guard:
            acquired = device_id not in self._active and len(self._active) < MAX_ACTIVE_DEVICES
            if acquired:
                self._active[device_id] = operation
        try:
            yield acquired
        finally:
            if acquired:
                with self._guard:
                    del self._active[device_id]

    def _expire_idle_locked(self, now: datetime) -> None:
        rows = self.db.fetchall(
            "SELECT request_id, device_id, forward_attempts, forward_expires_at, forward_inflight_until "
            "FROM tm_ingest_outbox WHERE state='pending' AND forward_payload_json IS NOT NULL"
        )
        for row in rows:
            if row["device_id"] in self._active:
                continue
            lease = _parse_stamp(row["forward_inflight_until"])
            if lease is not None and lease > now:
                continue
            expiry = _parse_stamp(row["forward_expires_at"])
            if expiry is None or expiry <= now:
                outbox.expire_pending(self.db, row["request_id"], "forward_ttl_expired")
            elif int(row["forward_attempts"]) >= MAX_FORWARD_ATTEMPTS:
                outbox.expire_pending(self.db, row["request_id"], "forward_attempts_exhausted")

    def enqueue(self, payload: dict) -> str:
        now = self._clock()
        if isinstance(payload, dict):
            payload = dict(payload)
        validate_ingest_payload(payload)
        has_timestamp = payload.get("updatedAt") not in (None, "")
        identity = {"payload": payload}
        if not has_timestamp:
            identity["receipt_local_day"] = _receipt_day(payload, now)
        fingerprint = hashlib.sha256(json.dumps(
            identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        # Default sample time belongs to enqueue, not a later retry/day. Its
        # input identity was captured first, so active retries can still coalesce.
        snapshot_payload = payload
        if not has_timestamp:
            snapshot_payload = {**payload, "updatedAt": utc_z(now)}
            if len(_serialized(snapshot_payload).encode("utf-8")) <= MAX_CORE_BODY_BYTES:
                payload = snapshot_payload
        device_id = str(payload.get("deviceId") or payload.get("id") or "")
        serialized = _serialized(payload)
        payload_bytes = len(serialized.encode("utf-8"))
        request_id = outbox.new_request_id()
        # Deletion claims the same guard before sending DELETE. While it owns
        # the device, no new row can land after the final purge and revive it.
        with self._guard:
            if self._active.get(device_id) == "delete":
                raise DeviceDeletingError("设备正在删除，请稍后重试")
            self._expire_idle_locked(now)
            with self.db.transaction():
                existing = self.db.fetchone(
                    "SELECT request_id FROM tm_ingest_outbox WHERE device_id=? AND payload_fingerprint=? "
                    "AND (state='pending' OR input_has_timestamp=1) ORDER BY ingest_sequence DESC LIMIT 1",
                    (device_id, fingerprint),
                )
                if existing is not None:
                    return existing["request_id"]
                used = self.db.fetchone(
                    "SELECT COALESCE(SUM(forward_payload_bytes), 0) AS n "
                    "FROM tm_ingest_outbox WHERE state='pending' AND forward_payload_json IS NOT NULL"
                )["n"]
                if int(used) + payload_bytes > self.max_bytes:
                    raise outbox.OutboxFullError("待发送数据已达容量上限，请稍后重试")
                outbox.record_pending(
                    self.db, request_id=request_id, device_id=device_id,
                    payload=snapshot_payload, max_pending=self.max_pending, received_at=utc_z(now),
                )
                self.db.execute(
                    "UPDATE tm_ingest_outbox SET forward_payload_json=?, forward_payload_bytes=?, "
                    "forward_next_at=?, forward_expires_at=?, payload_fingerprint=?, input_has_timestamp=? "
                    "WHERE request_id=?",
                    (serialized, payload_bytes, utc_z(now),
                     utc_z(now + timedelta(seconds=FORWARD_TTL_SECONDS)), fingerprint,
                     int(has_timestamp), request_id),
                )
        outbox._invalidate_overview(self.db)
        return request_id

    def has_pending(self) -> bool:
        return self.db.fetchone(
            "SELECT 1 FROM tm_ingest_outbox WHERE state='pending' AND forward_payload_json IS NOT NULL LIMIT 1"
        ) is not None

    def result_for_request(self, core, request_id: str) -> ForwardAttempt | None:
        """Resolve deduplication and an acknowledgement won by the background worker.

        Current stats are read only for the response. They are never written as
        the old request's snapshot. This read does not need device ownership and
        cannot make a confirmed request look queued while a successor is active.
        """
        from .tm_proxy import UpstreamUnavailable

        row = self.db.fetchone(
            "SELECT device_id, state, normalized_json, terminal_reason FROM tm_ingest_outbox WHERE request_id=?",
            (request_id,),
        )
        if row is None or (row["state"] == "pending" and row["normalized_json"] is None):
            return None
        if row["normalized_json"] is None:
            return ForwardAttempt(request_id, response=httpx.Response(409, json={
                "error": "upstream_request_finished",
                "message": "该次上报已结束且未能确认接收，请发送新的用量摘要",
                "reason": row["terminal_reason"],
            }))
        try:
            response = core.request("GET", "/api/stats")
            stats = response.json()
            if response.status_code != 200 or not isinstance(stats, dict) or not isinstance(stats.get("devices"), list):
                raise ValueError("current upstream stats unavailable")
        except (UpstreamUnavailable, httpx.HTTPError, ValueError):
            return ForwardAttempt(request_id, error_code="upstream_stats_unavailable", message="该次上报已确认，当前统计暂不可用")
        return ForwardAttempt(request_id, response=httpx.Response(200, json={
            "ok": True, "deviceId": row["device_id"], "stats": stats, "deduplicated": True,
        }))

    def _retry(
        self, row: dict, error: str, *, retry_after: str | None = None,
    ) -> int:
        now = self._clock()
        attempts = int(row["forward_attempts"]) + 1
        delay = min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** (attempts - 1))
        supplied_delay = retry_after_seconds(retry_after, now)
        if supplied_delay is not None:
            delay = max(delay, supplied_delay)
        with self.db.transaction():
            self.db.execute(
                "UPDATE tm_ingest_outbox SET last_error=?, forward_next_at=?, "
                "forward_inflight_until=NULL WHERE request_id=?",
                (error[:500], utc_z(now + timedelta(seconds=delay)), row["request_id"]),
            )
            if attempts >= MAX_FORWARD_ATTEMPTS:
                outbox.expire_pending(self.db, row["request_id"], "forward_attempts_exhausted")
            elif (_parse_stamp(row["forward_expires_at"]) or now) <= now:
                outbox.expire_pending(self.db, row["request_id"], "forward_ttl_expired")
        return max(1, math.ceil(delay))

    def _save_acknowledgement(self, row: dict, record: dict, incoming: dict) -> None:
        with self.db.transaction():
            outbox.save_normalized(self.db, row["request_id"], record)
            self.db.execute(
                "UPDATE tm_ingest_outbox SET forward_payload_json=NULL, forward_payload_bytes=0, "
                "forward_next_at=NULL, forward_inflight_until=NULL, payload_json=? WHERE request_id=?",
                (_serialized(outbox._slim_payload(incoming)), row["request_id"]),
            )

    def _write_acknowledged_snapshot(self, row: dict, payload: dict, record: dict) -> None:
        try:
            with self.db.transaction():
                written = write_snapshot(
                    self.db, device_id=row["device_id"], record=record, incoming=payload,
                    limits_only=is_limits_only_update(payload),
                    ingest_sequence=int(row["ingest_sequence"]),
                    force_received_at=row["received_at"],
                )
                outbox.mark_done(self.db, row["request_id"], snapshot_written=written is not None)
                if written is not None:
                    outbox.supersede_older_pending(self.db, row["device_id"], row["request_id"])
            outbox.set_snapshot_status(self.db, success=True)
        except outbox.DETERMINISTIC_FAILURES as exc:
            outbox.mark_rejected(self.db, row["request_id"], str(exc))
            outbox.set_snapshot_status(self.db, success=False, error=str(exc), request_id=row["request_id"])
            log.warning("快照确定性失败（保留已确认审计）: %s", exc)
        except Exception as exc:
            outbox.mark_failed(self.db, row["request_id"], str(exc))
            outbox.set_snapshot_status(self.db, success=False, error=str(exc), request_id=row["request_id"])
            log.warning("快照写入失败（已确认记录留待本地重放）: %s", exc)
        outbox._invalidate_overview(self.db)

    def process_device(self, core, device_id: str) -> ForwardAttempt:
        from .tm_proxy import UpstreamUnavailable

        with self.device_operation(device_id) as acquired:
            if not acquired:
                return ForwardAttempt()
            row = self.db.fetchone(
                "SELECT * FROM tm_ingest_outbox WHERE device_id=? AND state='pending' "
                "AND forward_payload_json IS NOT NULL ORDER BY ingest_sequence LIMIT 1",
                (device_id,),
            )
            if row is None:
                return ForwardAttempt()
            now = self._clock()
            lease = _parse_stamp(row["forward_inflight_until"])
            if lease is not None and lease > now:
                return ForwardAttempt(retry_after=max(1, math.ceil((lease - now).total_seconds())))
            expiry = _parse_stamp(row["forward_expires_at"])
            if expiry is None or expiry <= now or int(row["forward_attempts"]) >= MAX_FORWARD_ATTEMPTS:
                reason = "forward_attempts_exhausted" if int(row["forward_attempts"]) >= MAX_FORWARD_ATTEMPTS else "forward_ttl_expired"
                outbox.expire_pending(self.db, row["request_id"], reason)
                return ForwardAttempt(row["request_id"], error_code="upstream_retry_expired", message="该次上报重试已结束，失败原因已保留")
            due = _parse_stamp(row["forward_next_at"]) or now
            if due > now:
                return ForwardAttempt(retry_after=max(1, math.ceil((due - now).total_seconds())))
            try:
                payload = json.loads(row["forward_payload_json"])
            except (TypeError, ValueError):
                outbox.expire_pending(self.db, row["request_id"], "forward_payload_invalid")
                return ForwardAttempt(row["request_id"], error_code="upstream_retry_expired", message="暂存的上报数据损坏，失败记录已保留")
            incoming = payload
            # Complete forwarding envelopes created before timestamp freezing
            # can still be retried deterministically from their durable receipt.
            if isinstance(payload, dict) and payload.get("updatedAt") in (None, ""):
                receipt = _parse_stamp(row["received_at"])
                if receipt is None:
                    outbox.expire_pending(self.db, row["request_id"], "forward_receipt_invalid")
                    return ForwardAttempt(row["request_id"], error_code="upstream_retry_expired")
                incoming = {**payload, "updatedAt": utc_z(receipt)}
                if len(_serialized(incoming).encode("utf-8")) <= MAX_CORE_BODY_BYTES:
                    payload = incoming
                elif not _explicit_core_day(payload) and _receipt_day(payload, receipt) != _receipt_day(payload, now):
                    # Preserve the official 1MiB acceptance boundary without
                    # deleting any input fields. If a frozen timestamp cannot
                    # fit, an ambiguous old-day payload must not become today.
                    outbox.expire_pending(self.db, row["request_id"], "forward_sample_time_missing_across_day")
                    return ForwardAttempt(row["request_id"], error_code="upstream_retry_expired", message="上报缺少采样时间且已跨日，无法安全重发，失败记录已保留")
            self.db.execute(
                "UPDATE tm_ingest_outbox SET forward_attempts=forward_attempts+1, forward_inflight_until=? "
                "WHERE request_id=?",
                (utc_z(now + timedelta(seconds=INFLIGHT_GRACE_SECONDS)), row["request_id"]),
            )
            try:
                response = core.request("POST", "/api/ingest", json_body=payload)
            except (UpstreamUnavailable, httpx.HTTPError) as exc:
                delay = self._retry(row, str(exc))
                return ForwardAttempt(row["request_id"], error_code="upstream_unavailable", message="上游暂不可用，上报已暂存并等待重试", retry_after=delay)
            if response.status_code != 200:
                error = f"upstream HTTP {response.status_code}: {response.text[:350]}"
                if outbox.is_retryable_http(response.status_code):
                    delay = self._retry(row, error, retry_after=response.headers.get("Retry-After"))
                else:
                    with self.db.transaction():
                        outbox.mark_rejected(self.db, row["request_id"], error)
                        self.db.execute(
                            "UPDATE tm_ingest_outbox SET terminal_reason='upstream_rejected' WHERE request_id=?",
                            (row["request_id"],),
                        )
                    delay = RETRY_BASE_SECONDS
                outbox._invalidate_overview(self.db)
                return ForwardAttempt(row["request_id"], response=response, retry_after=delay)
            try:
                body = response.json()
                devices = (body.get("stats") or {}).get("devices") or []
                record = next((record for record in devices
                               if isinstance(record, dict) and str(record.get("deviceId")) == device_id), None)
                if record is None or not isinstance(record.get("periods"), dict):
                    raise ValueError("ingest response missing this request's normalized device")
                self._save_acknowledgement(row, record, incoming)
            except Exception as exc:
                # The core may already have accepted this body. Its complete
                # envelope remains at the device's head, so no later POST can
                # overtake this retry while the acknowledgement is unavailable.
                outbox.set_snapshot_status(self.db, success=False, error=str(exc), request_id=row["request_id"])
                delay = self._retry(row, f"acknowledgement unavailable: {exc}")
                outbox._invalidate_overview(self.db)
                return ForwardAttempt(row["request_id"], error_code="snapshot_ack_unavailable", message="上游已响应，确认保存后将继续处理后续上报", retry_after=delay)
            self._write_acknowledged_snapshot(row, incoming, record)
            return ForwardAttempt(row["request_id"], response=response)

    def process_due(self, core, *, max_items: int = outbox.REPLAY_BATCH, should_stop=None) -> dict:
        now = self._clock()
        with self._guard:
            self._expire_idle_locked(now)
            rows = self.db.fetchall(
                "SELECT device_id, forward_next_at, forward_inflight_until FROM tm_ingest_outbox "
                "WHERE state='pending' AND forward_payload_json IS NOT NULL ORDER BY ingest_sequence"
            )
            heads = []
            seen = set()
            for row in rows:
                device = row["device_id"]
                if device in seen:
                    continue
                seen.add(device)
                # Select a device's true head before applying due/batch limits.
                # Otherwise sleeping heads can starve unrelated ready devices,
                # or a later same-device row can overtake a sleeping head.
                due = max(_parse_stamp(row["forward_next_at"]) or now,
                          _parse_stamp(row["forward_inflight_until"]) or now)
                if device in self._active or due > now:
                    continue
                if len(heads) >= max_items:
                    break
                heads.append(row)
        processed = 0
        for head in heads:
            if should_stop is not None and should_stop():
                break
            result = self.process_device(core, head["device_id"])
            processed += result.request_id is not None
        return {"devices": len(heads), "processed": processed}

    def next_delay(self, default: float) -> float:
        now = self._clock()
        delay = default
        seen: set[str] = set()
        with self._guard:
            rows = self.db.fetchall(
                "SELECT device_id, forward_next_at, forward_expires_at, forward_inflight_until "
                "FROM tm_ingest_outbox WHERE state='pending' AND forward_payload_json IS NOT NULL "
                "ORDER BY ingest_sequence"
            )
            for row in rows:
                device = row["device_id"]
                if device in seen or device in self._active:
                    continue
                seen.add(device)
                due = min(_parse_stamp(row["forward_next_at"]) or now,
                          _parse_stamp(row["forward_expires_at"]) or now)
                lease = _parse_stamp(row["forward_inflight_until"])
                if lease is not None:
                    due = max(due, lease)
                delay = min(delay, (due - now).total_seconds())
        return max(0.1, delay)


def forwarding_queue(db: Database, *, max_pending: int) -> ForwardingQueue:
    """One coordinator shared by all routes and the maintenance worker for a DB."""
    with db._lock:
        current = getattr(db, "_tm_forwarding_queue", None)
        if current is None:
            current = ForwardingQueue(db, max_pending=max_pending)
            db._tm_forwarding_queue = current
        return current
