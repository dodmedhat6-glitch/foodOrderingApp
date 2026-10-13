"""Turns every failure into the error envelope — the ``errorHandler.ts`` of this service.

::

    {"success": false, "error": {"code": "...", "message": "..."}}

Two layers, because FastAPI raises errors at two depths:

- ``install(app, logger)`` registers *exception handlers* for what FastAPI
  itself catches inside the request: ``AppError`` raised by a service,
  controller or dependency; ``RequestValidationError`` from parameter and
  query-model validation; and Starlette's ``HTTPException`` (unknown route,
  wrong method).
- ``wrap(app, logger)`` adds an ASGI middleware for everything else — a
  bug. It answers 500 with the generic envelope and logs the stack once.
  Why not an ``Exception`` handler: Starlette runs that one in its outermost
  ``ServerErrorMiddleware``, which sends the response and then *re-raises*,
  so uvicorn logs the same crash a second time in its own format. Middleware
  added with ``add_middleware`` sits inside ``ServerErrorMiddleware``; an
  exception it swallows never reaches it.

Services and controllers never build responses for errors. They raise.
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from lib.errors.apperror import AppError
from lib.errors.errors import ERR_INTERNAL, ERR_METHOD_NOT_ALLOWED, ERR_NOT_FOUND, ERR_VALIDATION
from lib.logger.logger import Logger, from_context


def render(err: AppError) -> JSONResponse:
    body: dict[str, Any] = {"code": err.code, "message": err.message}
    if err.details:
        body["details"] = err.details
    return JSONResponse(status_code=err.status, content={"success": False, "error": body})


def install(app: FastAPI, logger: Logger) -> None:
    async def on_app_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, AppError)
        # Expected outcomes (bad input, no permission) are warnings; a 5xx
        # AppError (an upstream down) is an error someone should look at.
        log = from_context(logger).error if exc.status >= 500 else from_context(logger).warn
        log(exc.message, code=exc.code, status=exc.status, method=request.method, path=request.url.path)
        return render(exc)

    async def on_validation_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, RequestValidationError)
        # dict.fromkeys de-duplicates while keeping order: a parameter declared
        # by both a guard and the route (restaurantId) is validated twice and
        # would otherwise be reported twice.
        problems = [dict(p) for p in dict.fromkeys(tuple(_describe(e).items()) for e in exc.errors())]
        from_context(logger).warn(
            "request validation failed", path=request.url.path, problems=[p["field"] for p in problems]
        )
        # The first problem becomes the message so a client that only shows
        # `message` still shows something actionable.
        first = problems[0] if problems else {"field": "", "message": ERR_VALIDATION.message}
        message = f"{first['field']}: {first['message']}" if first["field"] else first["message"]
        return render(AppError(ERR_VALIDATION.code, ERR_VALIDATION.status, message, {"problems": problems}))

    async def on_http_exception(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, StarletteHTTPException)
        if exc.status_code == 404:
            return render(ERR_NOT_FOUND)
        if exc.status_code == 405:
            return render(ERR_METHOD_NOT_ALLOWED)
        return render(AppError(f"HTTP_{exc.status_code}", exc.status_code, str(exc.detail)))

    app.add_exception_handler(AppError, on_app_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)
    app.add_exception_handler(StarletteHTTPException, on_http_exception)


class _ErrorBoundary:
    """Last line of defence: any exception nobody handled becomes a 500 envelope."""

    def __init__(self, app: ASGIApp, logger: Logger) -> None:
        self._app = app
        self._logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self._app(scope, receive, tracking_send)
        except Exception:
            from_context(self._logger).error(
                "unhandled error", exc_info=True, method=scope.get("method"), path=scope.get("path")
            )
            if started:
                # Headers are already on the wire; the only honest thing left
                # is to drop the connection, which re-raising does.
                raise
            await render(ERR_INTERNAL)(scope, receive, send)


def wrap(app: FastAPI, logger: Logger) -> None:
    """Install the boundary. Call it *before* adding any other middleware:
    the first ``add_middleware`` call ends up innermost."""
    app.add_middleware(_ErrorBoundary, logger=logger)


def _describe(error: Any) -> dict[str, str]:
    """One pydantic error -> {"field": "query.from", "message": "Field required"}."""
    loc = [str(part) for part in error.get("loc", ())]
    return {"field": ".".join(loc), "message": str(error.get("msg", "invalid"))}
