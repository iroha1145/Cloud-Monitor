from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from .config import Settings


def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    ) or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def require_api_key(request: Request, settings: Settings) -> None:
    if not settings.api_key:
        raise HTTPException(status_code=500, detail="服务器未配置 API_KEY")
    token = _bearer_token(request)
    if not hmac.compare_digest(token.encode("utf-8"), settings.api_key.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_access_token(request: Request, settings: Settings) -> None:
    expected = settings.access_token or settings.api_key
    if not expected:
        raise HTTPException(status_code=500, detail="服务器未配置访问密钥")
    token = _bearer_token(request)
    if not hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")
