"""AppError and the error envelope — order-service's `AppError.ts` + `errorHandler.ts`.

    {"success": false, "error": {"code": "...", "message": "...", "details": {...}?}}

Services and controllers `raise`; only this module builds error responses.
Unhandled exceptions (bugs) become a 500 in `lib/http.py`'s middleware.
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from lib.logger import logger


class AppError(Exception):
    """`code` is what clients branch on, `status` the HTTP status, `message` for humans.

    Canonical cases are module-level instances (`ERR_X = AppError(...)`), raised as
    `raise ERR_X` — or `raise ERR_X.with_details(...)`, which copies rather than
    mutating the shared instance.
    """

    def __init__(self, code: str, status: int, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code, self.status, self.message, self.details = code, status, message, details

    def with_details(self, **details: Any) -> "AppError":
        return AppError(self.code, self.status, self.message, {**(self.details or {}), **details})


ERR_VALIDATION = AppError("VALIDATION_ERROR", 400, "Request validation failed")
ERR_NOT_FOUND = AppError("NOT_FOUND", 404, "Route not found")
ERR_METHOD_NOT_ALLOWED = AppError("METHOD_NOT_ALLOWED", 405, "Method not allowed")
ERR_INTERNAL = AppError("INTERNAL_ERROR", 500, "Something went wrong")


def render(err: AppError) -> JSONResponse:
    body: dict[str, Any] = {"code": err.code, "message": err.message}
    if err.details:
        body["details"] = err.details
    return JSONResponse(status_code=err.status, content={"success": False, "error": body})


def install_error_handlers(app: FastAPI) -> None:
    async def on_app_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, AppError)
        log = logger.error if exc.status >= 500 else logger.warn
        log(exc.message, code=exc.code, status=exc.status, path=request.url.path)
        return render(exc)

    async def on_validation_error(request: Request, exc: Exception) -> JSONResponse:
        # Replaces FastAPI's default `422 {"detail": [...]}` with the platform envelope.
        assert isinstance(exc, RequestValidationError)
        problems: list[dict[str, str]] = []
        for e in exc.errors():
            problem = {"field": ".".join(str(p) for p in e["loc"]), "message": str(e["msg"])}
            if problem not in problems:  # a param checked by a guard *and* the route is reported once
                problems.append(problem)
        logger.warn("request validation failed", path=request.url.path, fields=[p["field"] for p in problems])
        first = f"{problems[0]['field']}: {problems[0]['message']}" if problems else ERR_VALIDATION.message
        return render(AppError(ERR_VALIDATION.code, 400, first, {"problems": problems}))

    async def on_http_error(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, HTTPException)
        if exc.status_code == 404:
            return render(ERR_NOT_FOUND)
        if exc.status_code == 405:
            return render(ERR_METHOD_NOT_ALLOWED)
        return render(AppError(f"HTTP_{exc.status_code}", exc.status_code, str(exc.detail)))

    app.add_exception_handler(AppError, on_app_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)
    app.add_exception_handler(HTTPException, on_http_error)
