from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence



class Database:
    """单连接 + RLock 的线程安全 SQLite 访问层。

    所有读写都在锁内执行；写路径通过 transaction() 以
    BEGIN IMMEDIATE 显式开事务，异常统一 ROLLBACK。
    """

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._closed = False
        self._prune_thread: Optional[threading.Thread] = None
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(
                str(self.path), check_same_thread=False, isolation_level=None
            )
        else:
            self._conn = sqlite3.connect(
                ":memory:", check_same_thread=False, isolation_level=None
            )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 30000")
        try:
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")
            self._conn.execute("PRAGMA auto_vacuum = INCREMENTAL")
            self._conn.execute("PRAGMA mmap_size = 268435456")
            self._conn.execute("PRAGMA cache_size = -32000")
            self._conn.execute("PRAGMA temp_store = MEMORY")
        except sqlite3.Error:
            pass

    # Token Monitor owns its schemas in tm_snapshots/tm_outbox/tm_forwarding.
    # Existing unrelated tables and PRAGMA user_version are left untouched.

    # ------------------------------------------------------------ lifecycle

    def close(self) -> None:
        thread = self._prune_thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        with self._lock:
            if self._closed:
                return
            self._conn.close()
            self._closed = True

    @contextmanager
    def transaction(self):
        """显式事务：BEGIN IMMEDIATE，异常时 ROLLBACK 并向上抛出。"""
        with self._lock:
            if self._conn.in_transaction:
                # 嵌套调用复用外层事务（RLock 可重入）
                yield self._conn
                return
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                try:
                    self._conn.execute("COMMIT")
                except BaseException:
                    # A failed COMMIT can leave the shared connection inside
                    # its transaction. Later requests must not silently join
                    # that failed batch or acknowledge uncommitted delivery.
                    if self._conn.in_transaction:
                        self._conn.execute("ROLLBACK")
                    raise

    # ------------------------------------------------------------ accessors

    @contextmanager
    def probe_access(self, timeout_seconds: float = 1.0):
        """Bound both the process lock and SQLite waits for readiness reads.

        Keep the shared connection locked while temporarily shortening its busy
        timeout, so application transactions retain their normal wait policy.
        Long-running probe queries are interrupted by the same deadline.
        """
        deadline = time.monotonic() + timeout_seconds
        if not self._lock.acquire(timeout=timeout_seconds):
            raise sqlite3.OperationalError("database busy during readiness probe")
        previous_timeout = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise sqlite3.OperationalError("readiness probe deadline exceeded")
            previous_timeout = int(self._conn.execute("PRAGMA busy_timeout").fetchone()[0])
            self._conn.execute(f"PRAGMA busy_timeout = {max(1, int(remaining * 1000))}")
            self._conn.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
            yield self
        finally:
            try:
                if previous_timeout is not None:
                    self._conn.set_progress_handler(None, 0)
                    self._conn.execute(f"PRAGMA busy_timeout = {previous_timeout}")
            finally:
                self._lock.release()

    def probe_write(self) -> None:
        """就绪探活：BEGIN IMMEDIATE + ROLLBACK 必须在同一次持锁内完成。

        拆成两次 execute 会在中间释放 RLock，让等待中的写事务复用
        in_transaction 嵌套分支，随后被探针 ROLLBACK 整体回滚。
        """
        with self._lock:
            if self._conn.in_transaction:
                return
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute("ROLLBACK")

    def execute(
        self, sql: str, params: Sequence[Any] = ()
    ) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def executemany(self, sql: str, seq: Iterable[Sequence[Any]]) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.executemany(sql, seq)

    def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def fetchone(self, sql: str, params: Sequence[Any] = ()) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row is not None else None
