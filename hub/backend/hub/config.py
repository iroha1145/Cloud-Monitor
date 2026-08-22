from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_frontend_dir() -> Path:
    return _project_root() / "frontend"


def _default_database_path() -> Path:
    return _project_root() / "data" / "cloud-monitor.sqlite3"


@dataclass(frozen=True)
class Settings:
    api_key: str
    access_token: str
    database_path: Path
    frontend_dir: Path
    max_records_per_push: int


def load_settings() -> Settings:
    api_key = os.environ.get("API_KEY", "")
    access_token = os.environ.get("ACCESS_TOKEN", "") or api_key
    raw_db = os.environ.get("DATABASE_PATH")
    database_path = Path(raw_db).expanduser() if raw_db else _default_database_path()
    if not database_path.is_absolute():
        database_path = (_project_root() / database_path).resolve()
    raw_frontend = os.environ.get("FRONTEND_DIR")
    frontend_dir = (
        Path(raw_frontend).expanduser().resolve()
        if raw_frontend
        else _default_frontend_dir()
    )
    try:
        max_records = int(os.environ.get("MAX_RECORDS_PER_PUSH", "500"))
    except ValueError:
        max_records = 500
    return Settings(
        api_key=api_key,
        access_token=access_token,
        database_path=database_path,
        frontend_dir=frontend_dir,
        max_records_per_push=max(1, max_records),
    )
