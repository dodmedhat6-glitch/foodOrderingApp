"""Correlation id + access log, as pure ASGI middleware.

Pure ASGI (a class with ``__call__(scope, receive, send)``) rather than
Starlette's ``BaseHTTPMiddleware`` on purpose: ``BaseHTTPMiddleware`` runs the
downstream app in a *separate task*, and a ContextVar set in one task is not
guaranteed to be what the other sees once both are running. Setting the
correlation id and then calling the app in the same task is what makes
``lib.appcontext.context.correlation_id()`` reliable in every layer below.
"""

import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from lib.appcontext.context import reset_correlation_id, set_correlation_id
from lib.logger.logger import Logger, from_context

HEADER = "X-CorrelationId"
_INCOMING = (b"x-correlationid", b"x-correlation-id")
_MAX_LEN = 128


class CorrelationMiddleware:
    """Reuse the caller's correlation id or mint one; echo it on the response.

    Same contract as ``correlationId.ts``: accept ``X-CorrelationId`` or
    ``X-Correlation-Id``, answer with ``X-CorrelationId``. An overlong value
    is replaced, not trusted — it ends up in every log line we write.
    """

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        incoming = next(
            (value.decode("latin-1") for name, value in scope["headers"] if name in _INCOMING), ""
        )
        cid = incoming if 0 < len(incoming) <= _MAX_LEN else str(uuid.uuid4())

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).append(HEADER, cid)
            await send(message)

        token = set_correlation_id(cid)
        try:
            await self._app(scope, receive, send_with_header)
        finally:
            reset_correlation_id(token)


class AccessLogMiddleware:
    """One line per request with method, path, status and duration.

    Sits inside ``CorrelationMiddleware`` so the line carries the correlation
    id, and outside the error boundary so it records the status the client
    actually got — including a 500.
    """

    def __init__(self, app: ASGIApp, logger: Logger) -> None:
        self._app = app
        self._logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        started = time.perf_counter()
        status = 500

        async def capture_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self._app(scope, receive, capture_status)
        finally:
            from_context(self._logger).info(
                "http request",
                method=scope["method"],
                path=scope["path"],
                status=status,
                ms=round((time.perf_counter() - started) * 1000, 1),
            )
