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


def constant_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class CodedHTTPException(HTTPException):
    """带稳定 error 码的 HTTP 错误，供前端做精确引导（L-09）。"""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(status_code=status_code, detail=message)
        self.code = code


@dataclass(frozen=True)
class AccessBinding:
    """只读/面板鉴权结果：default 为根 ACCESS_TOKEN，否则为命中的租户。"""

    tenant_id: str = "default"
    role: str = "admin"  # "admin" | "user"


def resolve_access_binding(
    request: Request, settings: Settings, *, allow_tenants: bool = True
) -> AccessBinding:
    expected = settings.access_token
    if not expected and not (allow_tenants and settings.tenants):
        raise CodedHTTPException(
            500, "access_token_unconfigured", "服务器未配置访问密钥"
        )
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if expected and constant_eq(token, expected):
        return AccessBinding(tenant_id="default", role="admin")
    if allow_tenants:
        for tenant_id, tenant in settings.tenants.items():
            if constant_eq(token, tenant.access_token):
                return AccessBinding(tenant_id=tenant_id, role=tenant.role)
    raise HTTPException(status_code=401, detail="Unauthorized")


def require_access_token(request: Request, settings: Settings) -> None:
    resolve_access_binding(request, settings, allow_tenants=False)
