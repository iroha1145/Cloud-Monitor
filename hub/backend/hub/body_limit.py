"""ASGI receive 层的请求体大小限制（真实正文字节，覆盖所有写接口）。

不依赖 Content-Length：进入应用前把正文按实际到达字节缓冲完整
（bytearray 累加，避免不可变 bytes 拼接的平方级复制），支持任意分块
方式；一旦累计超限立即 413（connection: close），不再调用应用，剩余
正文不再消费。伪造/缺失 Content-Length 均按实际正文判定。

路径限额（P1-6 统一中间件）：
- /api/ingest、/api/subscriptions：1 MiB（与官方 hub 一致）
- /api/v1/sync/push：可配置（MAX_SYNC_BODY_BYTES，默认 2 MiB）
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable, Mapping

MAX_TM_BODY_BYTES = 1024 * 1024  # 与官方 readJsonBody 的 MAX_JSON_BODY_BYTES 一致

DEFAULT_LIMITED_PATHS: Mapping[str, int] = {
    "/api/ingest": MAX_TM_BODY_BYTES,
    "/api/subscriptions": MAX_TM_BODY_BYTES,
}


class TmBodyLimitMiddleware:
    def __init__(self, app, *, limits: Mapping[str, int] | None = None):
        self.app = app
        self.limits = dict(limits) if limits else dict(DEFAULT_LIMITED_PATHS)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        limit = self.limits.get(scope.get("path"))
        if limit is None:
            await self.app(scope, receive, send)
            return

        body = bytearray()
        exceeded = False
        while True:
            message = await receive()
            mtype = message.get("type")
            if mtype == "http.request":
                body += message.get("body", b"") or b""
                if len(body) > limit:
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
                    "message": f"正文超过 {limit} 字节",
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

        pending: list = [{"type": "http.request", "body": bytes(body), "more_body": False}]

        async def replay_receive():
            if pending:
                return pending.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)
