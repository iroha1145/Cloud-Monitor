"""Use Starlette's compression while honoring the client's encoding quality."""

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware


def _accepts_gzip(value: str) -> bool:
    wildcard = False
    for item in value.lower().split(","):
        encoding, *parameters = (part.strip() for part in item.split(";"))
        quality = next((part[2:] for part in parameters if part.startswith("q=")), "1")
        try:
            accepted = 0 < float(quality) <= 1
        except ValueError:
            accepted = False
        if encoding == "gzip":
            return accepted
        if encoding == "*":
            wildcard = accepted
    return wildcard


class NegotiatedGZipMiddleware(GZipMiddleware):
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            # Starlette 1.6 selects gzip by substring, including gzip;q=0.
            # Normalize just the negotiation; its standard responders still
            # handle size, Vary, streaming, and the event-stream exclusion.
            accepted = ",".join(Headers(scope=scope).getlist("accept-encoding"))
            encoding = "gzip" if _accepts_gzip(accepted) else "identity"
            scope = {
                **scope,
                "headers": [(key, value) for key, value in scope["headers"] if key.lower() != b"accept-encoding"]
                + [(b"accept-encoding", encoding.encode())],
            }
        await super().__call__(scope, receive, send)
