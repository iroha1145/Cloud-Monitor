from __future__ import annotations

import hashlib
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence


SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    agent_version TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    source_instance_id TEXT NOT NULL DEFAULT 'legacy',
    local_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT ''
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_usage_created_at_id
    ON usage_records(created_at, id);
CREATE INDEX IF NOT EXISTS idx_usage_device_created
    ON usage_records(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_created
    ON usage_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_created
    ON usage_records(model_name, created_at);
DROP INDEX IF EXISTS idx_usage_created_at;
DROP INDEX IF EXISTS idx_usage_user_id;
DROP INDEX IF EXISTS idx_usage_model_name;
DROP INDEX IF EXISTS idx_usage_device_id;
"""

UNIQUE_INDEX = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_device_source_local
    ON usage_records(device_id, source_instance_id, local_id);
"""

# v1 时期的旧唯一索引，迁移时必须删除（否则 local_id 复用会被静默吞掉）
LEGACY_UNIQUE_INDEX = "idx_records_device_local"

# PRAGMA 不支持绑定参数：两处整句 SQL 均为无外部输入的静态字面量；
# 若 SCHEMA_VERSION / LEGACY_UNIQUE_INDEX 变更，必须同步下方两条语句
_ASSERT_DB_CONSTANTS = (SCHEMA_VERSION == 2, LEGACY_UNIQUE_INDEX == "idx_records_device_local")
if not all(_ASSERT_DB_CONSTANTS):
    raise RuntimeError("db.py 中的静态 SQL 常量与 SCHEMA_VERSION 不一致")


def record_fingerprint(
    *,
    user_id: str,
    nickname: str,
    model_name: str,
    input_tokens: int,
    output_tokens: int,
    created_at: str,
) -> str:
    raw = "|".join(
        (
            str(user_id),
            str(nickname),
            str(model_name),
            str(int(input_tokens)),
            str(int(output_tokens)),
            str(created_at),
        )
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _row_fingerprint(row: sqlite3.Row) -> str:
    return record_fingerprint(
        user_id=row["user_id"],
        nickname=row["nickname"],
        model_name=row["model_name"],
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        created_at=row["created_at"],
    )


class Database:
    """单连接 + RLock 的线程安全 SQLite 访问层。

    所有读写都在锁内执行；写路径通过 transaction() 以
    BEGIN IMMEDIATE 显式开事务，异常统一 ROLLBACK。
    """

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._closed = False
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
        self._apply_schema()

    # ------------------------------------------------------------ migration

    def _user_version(self) -> int:
        row = self._conn.execute("PRAGMA user_version").fetchone()
        return int(row[0])

    def _apply_schema(self) -> None:
        with self._lock:
            version = self._user_version()
            self._conn.executescript(SCHEMA)
            if version < SCHEMA_VERSION:
                self._migrate(version)
            self._conn.executescript(INDEXES)
            self._conn.executescript(UNIQUE_INDEX)
            # PRAGMA 不支持绑定参数；整句静态字面量，与 SCHEMA_VERSION=2 对应
            self._conn.execute("PRAGMA user_version = 2")

    def _migrate(self, from_version: int) -> None:
        """v0 → v2: 补 source_instance_id/fingerprint 列，换唯一索引，回填指纹。

        幂等：重复执行不会破坏数据；不清空任何现有行。
        """
        columns = {
            str(row["name"])
            for row in self._conn.execute("PRAGMA table_info(usage_records)")
        }
        if "source_instance_id" not in columns:
            self._conn.execute(
                "ALTER TABLE usage_records ADD COLUMN source_instance_id"
                " TEXT NOT NULL DEFAULT 'legacy'"
            )
        if "fingerprint" not in columns:
            self._conn.execute(
                "ALTER TABLE usage_records ADD COLUMN fingerprint"
                " TEXT NOT NULL DEFAULT ''"
            )
        # 旧库全部视为 legacy 实例；已带新列但值为空的行同样归入 legacy
        self._conn.execute(
            "UPDATE usage_records SET source_instance_id = 'legacy'"
            " WHERE source_instance_id = ''"
        )
        if from_version < 1:
            # 旧唯一索引 (device_id, local_id) 与新语义冲突，必须删除；
            # 静态字面量，与 LEGACY_UNIQUE_INDEX 对应
            self._conn.execute('DROP INDEX IF EXISTS "idx_records_device_local"')
        # 为存量行回填指纹，使同一内容重推仍能命中 duplicates 而非 conflicts
        #（注意 AUTOINCREMENT 表的 rowid 就是 id 主键，不能按 "rowid" 键名取值）
        rows = self._conn.execute(
            "SELECT id, user_id, nickname, model_name, input_tokens,"
            " output_tokens, created_at FROM usage_records WHERE fingerprint = ''"
        ).fetchall()
        for row in rows:
            self._conn.execute(
                "UPDATE usage_records SET fingerprint = ? WHERE id = ?",
                (_row_fingerprint(row), row["id"]),
            )

    # ------------------------------------------------------------ lifecycle

    def close(self) -> None:
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
                self._conn.execute("COMMIT")

    # ------------------------------------------------------------ accessors

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
