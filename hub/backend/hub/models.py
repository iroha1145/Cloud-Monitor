"""push 请求的 Pydantic 校验模型：长度上限、严格整数、时间戳合法性。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from pydantic import BaseModel, Field, field_validator

MAX_INT = 2**62  # 安全低于 SQLite 64 位上限
MAX_FUTURE_SKEW = timedelta(hours=48)


class DeviceInfo(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(default="", max_length=128)
    platform: str = Field(default="", max_length=64)
    agent_version: str = Field(default="", max_length=64)


class UserIn(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    email: str = Field(default="", max_length=254)
    name: str = Field(default="", max_length=128)
    role: str = Field(default="user", max_length=32)
    created_at: Optional[str] = Field(default=None, max_length=64)
    updated_at: Optional[str] = Field(default=None, max_length=64)


class RecordIn(BaseModel):
    local_id: int = Field(ge=1, le=MAX_INT, strict=True)
    user_id: str = Field(min_length=1, max_length=128)
    nickname: str = Field(default="", max_length=128)
    model_name: str = Field(default="", max_length=256)
    input_tokens: int = Field(default=0, ge=0, le=MAX_INT, strict=True)
    output_tokens: int = Field(default=0, ge=0, le=MAX_INT, strict=True)
    created_at: str = Field(min_length=1, max_length=64)

    @field_validator("created_at")
    @classmethod
    def _valid_created_at(cls, value: str) -> str:
        raw = value.strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise ValueError("created_at 不是合法的 ISO 8601 时间") from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        if dt > datetime.now(timezone.utc) + MAX_FUTURE_SKEW:
            raise ValueError("created_at 超前服务器时间过多（上限 48 小时）")
        return dt.replace(microsecond=0).isoformat()


class SyncPushRequest(BaseModel):
    device: DeviceInfo
    users: list[UserIn] = Field(default_factory=list)
    records: list[RecordIn] = Field(default_factory=list)
    source_instance_id: str = Field(default="legacy", min_length=1, max_length=128)
