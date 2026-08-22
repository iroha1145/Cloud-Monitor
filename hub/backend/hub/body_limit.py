"""ASGI receive 层的请求体大小限制（官方 hub 上限 1 MiB）。

不依赖 Content-Length：在进入应用前把正文按实际到达字节缓冲完整
（≤1MiB），支持任意分块方式；一旦累计超限立即 413（connection: close），
不再调用应用，剩余正文不再消费。伪造/缺失 Content-Length 均按实际正文
判定。仅作用于 token-monitor 写入端点（POST /api/ingest、PUT
/api/subscriptions）。
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable

MAX_TM_BODY_BYTES = 1024 * 1024  # 与官方 readJsonBody 的 MAX_JSON_BODY_BYTES 一致
TM_LIMITED_PATHS = {"/api/ingest", "/api/subscriptions"}


class TmBodyLimitMiddleware:
    def __init__(self, app, *, max_bytes: int = MAX_TM_BODY_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") not in TM_LIMITED_PATHS:
            await self.app(scope, receive, send)
            return

        body = b""
        exceeded = False
        while True:
            message = await receive()
            mtype = message.get("type")
            if mtype == "http.request":
                body += message.get("body", b"") or b""
                if len(body) > self.max_bytes:
                    exceeded = True
                    break
                if not message.get("more_body"):
                    break
            elif mtype == "http.disconnect":
                return  # 客户端断开，无需响应

        if exceeded:
            payload = json.dumps(
                {
                    "error": "payload_too_large",
                    "message": f"正文超过 {self.max_bytes} 字节",
                }
            ).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(payload)).encode()),
                        (b"connection", b"close"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": payload})
            return

        pending: list = [{"type": "http.request", "body": body, "more_body": False}]

        async def replay_receive():
            if pending:
                return pending.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)
