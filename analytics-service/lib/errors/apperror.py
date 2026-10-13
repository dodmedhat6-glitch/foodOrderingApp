from collections.abc import Mapping
from typing import Any


class AppError(Exception):
    """An error with a stable, client-facing identity.

    ``code`` is what clients branch on (``ANALYTICS_INVALID_DATE_RANGE``),
    ``status`` is the HTTP status, ``message`` is for humans. The error
    handler (``handler.py``) renders exactly these three, plus ``details``
    when a contract carries machine-readable context.

    The canonical cases are module-level instances — ``ERR_… = AppError(...)``
    in each module's ``errors.py`` — raised as ``raise ERR_…``. Construct one
    inline only for a case that has no stable name.
    """

    def __init__(
        self,
        code: str,
        status: int,
        message: str,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.details = dict(details) if details else None

    def with_details(self, **details: Any) -> "AppError":
        """A copy of a canonical error carrying request-specific context, so
        the shared module-level instance is never mutated."""
        return AppError(self.code, self.status, self.message, {**(self.details or {}), **details})

    def __repr__(self) -> str:
        return f"AppError({self.code!r}, {self.status}, {self.message!r})"
