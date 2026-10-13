"""JSON logging on stdlib `logging` — same line shape as the Node services' Logger:

    {"level": "info", "message": "mongo connected", "timestamp": 1760000000000, "db": "..."}

`correlation_id` is a ContextVar (async Python's AsyncLocalStorage). The request
middleware and the event consumer set it; the formatter stamps it on every line
written while it is set, so nobody passes it around by hand.
"""

import json
import logging
import sys
from contextvars import ContextVar
from typing import Any

correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)

_NAME = "analytics"
_LEVELS = {logging.DEBUG: "debug", logging.INFO: "info", logging.WARNING: "warn", logging.ERROR: "error"}


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "level": _LEVELS.get(record.levelno, "error"),
            "message": record.getMessage(),
            "timestamp": int(record.created * 1000),
        }
        if record.name != _NAME:  # uvicorn, aio-pika, pymongo
            line["logger"] = record.name
        if cid := correlation_id.get():
            line["correlationId"] = cid
        line.update(getattr(record, "fields", {}))
        if record.exc_info:
            line["stack"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str)


class Logger:
    """`logger.info("msg", key=value)` — keyword fields become JSON keys (camelCase, like the Node logs)."""

    def __init__(self) -> None:
        self._log = logging.getLogger(_NAME)

    def debug(self, message: str, **fields: Any) -> None:
        self._log.debug(message, extra={"fields": fields})

    def info(self, message: str, **fields: Any) -> None:
        self._log.info(message, extra={"fields": fields})

    def warn(self, message: str, **fields: Any) -> None:
        self._log.warning(message, extra={"fields": fields})

    def error(self, message: str, *, exc_info: bool = False, **fields: Any) -> None:
        self._log.error(message, exc_info=exc_info, extra={"fields": fields})


logger = Logger()


def configure(level: str = "INFO") -> None:
    """One JSON handler on the root logger, so library records come out in the same format."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    for name in ("aio_pika", "aiormq", "pymongo", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
