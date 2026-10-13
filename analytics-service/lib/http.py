"""HTTP glue: the success envelope and the one request middleware.

{"success": true, "data": ...}
"""

import time
import uuid
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from lib.errors import ERR_INTERNAL, render
from lib.logger import correlation_id, logger


def send_success(data: Any, status: int = 200) -> JSONResponse:
    """`data` is a response DTO or a list of them; models serialize by alias (camelCase)."""
    return JSONResponse(status_code=status, content={"success": True, "data": jsonable_encoder(data)})


class RequestMiddleware:
    """Per request: correlation id in/out, a 500 envelope for any unhandled bug, one access-log line.

    Pure ASGI (not `BaseHTTPMiddleware`) so the ContextVar set here is the one every
    layer below sees. Added with `app.add_middleware`, it sits *inside* Starlette's
    `ServerErrorMiddleware`, so a bug caught here is logged once — an
    `Exception` handler would run outside and the crash would be logged twice.
    """

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        incoming = (headers.get(b"x-correlationid") or headers.get(b"x-correlation-id") or b"").decode(
            "latin-1"
        )
        cid = incoming if 0 < len(incoming) <= 128 else str(uuid.uuid4())
        token = correlation_id.set(cid)
        started, status, responded = time.perf_counter(), 500, False

        async def send_wrapper(message: Message) -> None:
            nonlocal status, responded
            if message["type"] == "http.response.start":
                status, responded = message["status"], True
                MutableHeaders(scope=message).append("X-CorrelationId", cid)
            await send(message)

        try:
            await self._app(scope, receive, send_wrapper)
        except Exception:
            logger.error("unhandled error", exc_info=True, path=scope["path"])
            if responded:  # headers already sent: dropping the connection is all that's left
                raise
            await render(ERR_INTERNAL)(scope, receive, send_wrapper)
        finally:
            ms = round((time.perf_counter() - started) * 1000, 1)
            logger.info("http request", method=scope["method"], path=scope["path"], status=status, ms=ms)
            correlation_id.reset(token)
