"""Structured JSON logging on top of the stdlib ``logging`` module.

Output matches the Node services' ``Logger`` line for line — one JSON object
per line with ``level``, ``message``, ``timestamp`` (epoch ms) and the
metadata flattened in — so one log pipeline and one query language cover all
three services::

    {"level": "info", "message": "mongo connected", "timestamp": 1760000000000, "db": "quickbite_analytics"}

Metadata keys are camelCase (``correlationId``, ``eventId``) for the same
reason: a search for ``correlationId`` should find the line in every service.

Usage::

    logger.info("event consumer started", queue=opts.queue)
    from_context().warn("unknown event type", eventType=t)   # + correlationId
"""

import json
import logging
import sys
from typing import Any

from lib.appcontext.context import claims, correlation_id

_ROOT = "analytics"


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "message": record.getMessage(),
            "timestamp": int(record.created * 1000),
        }
        # Records from third-party loggers (uvicorn, aio-pika, pymongo) are
        # tagged with their origin; our own carry their fields instead.
        if not record.name.startswith(_ROOT):
            line["logger"] = record.name
        line.update(getattr(record, "fields", {}))
        if record.exc_info:
            line["stack"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str)


_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


class Logger:
    """A thin wrapper so call sites read like the Node ones:
    ``logger.info("msg", key=value)`` instead of ``extra={"fields": {...}}``.

    ``bind`` returns a new Logger carrying extra fields on every line; the
    original is untouched, so a bound logger is safe to keep per request.
    """

    def __init__(self, name: str = _ROOT, fields: dict[str, Any] | None = None) -> None:
        self._log = logging.getLogger(name)
        self._fields = fields or {}

    def bind(self, **fields: Any) -> "Logger":
        return Logger(self._log.name, {**self._fields, **fields})

    def debug(self, message: str, **fields: Any) -> None:
        self._emit(logging.DEBUG, message, fields)

    def info(self, message: str, **fields: Any) -> None:
        self._emit(logging.INFO, message, fields)

    def warn(self, message: str, **fields: Any) -> None:
        self._emit(logging.WARNING, message, fields)

    def error(self, message: str, *, exc_info: bool = False, **fields: Any) -> None:
        self._emit(logging.ERROR, message, fields, exc_info=exc_info)

    def _emit(self, level: int, message: str, fields: dict[str, Any], exc_info: bool = False) -> None:
        if self._log.isEnabledFor(level):
            self._log.log(
                level, message, extra={"fields": {**self._fields, **fields}}, exc_info=exc_info, stacklevel=3
            )


#: The process-wide logger. Safe as a module global: it holds no request state.
logger = Logger()


def from_context(base: Logger | None = None) -> Logger:
    """``base`` (default: ``logger``) bound to the current request's or message's context.

    The Node services pass ``correlationId`` to every log call by hand; here
    the correlation middleware has already put it in a ContextVar, so this
    reads it back. Call it inside the request — not at import time, where
    there is no context yet.
    """
    base = base or logger
    fields: dict[str, Any] = {}
    cid = correlation_id()
    if cid:
        fields["correlationId"] = cid
    who = claims()
    if who is not None:
        fields["userId"] = who.user_id
    return base.bind(**fields) if fields else base


def configure(level: str = "INFO") -> None:
    """Route every logger in the process — ours and the libraries' — to one
    JSON handler on stdout. Called once, first thing in ``lib/boot``."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)

    # uvicorn installs its own handlers unless told otherwise (log_config=None
    # in lib/boot); make sure its loggers propagate to ours. Its access log is
    # off — lib/middleware/correlation.py writes one with the correlation id.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lib_logger = logging.getLogger(name)
        lib_logger.handlers.clear()
        lib_logger.propagate = True
    # Chatty at INFO and not ours to act on.
    for name in ("aio_pika", "aiormq", "pymongo", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
