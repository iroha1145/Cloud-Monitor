from __future__ import annotations

import hmac
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .config import Settings


def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def _constant_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def require_access_token(request: Request, settings: Settings) -> None:
    expected = settings.access_token
    if not expected:
        raise HTTPException(status_code=500, detail="服务器未配置访问密钥")
    if not _constant_eq(_bearer_token(request), expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@dataclass(frozen=True)
class WriteBinding:
    """写入鉴权结果：admin 可写任意设备；device 绑定单一设备。"""

    role: str  # "admin" | "device"
    device_id: str | None = None


def resolve_write_binding(request: Request, settings: Settings) -> WriteBinding:
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if settings.api_key and _constant_eq(token, settings.api_key):
        return WriteBinding(role="admin")
    for device_id, key in settings.device_keys.items():
        if _constant_eq(token, key):
            return WriteBinding(role="device", device_id=device_id)
    raise HTTPException(status_code=401, detail="Unauthorized")


def enforce_device_binding(binding: WriteBinding, payload_device_id: str) -> None:
    """设备密钥只能以其绑定的 device.id 推送，防止设备间冒充。"""
    if binding.role == "device" and binding.device_id != payload_device_id:
        raise HTTPException(
            status_code=403,
            detail=f"该写入密钥仅允许设备 {binding.device_id} 使用",
        )
