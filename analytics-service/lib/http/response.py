"""The success envelope — ``lib/http/response.ts`` in the Node services.

::

    {"success": true, "data": ...}
    {"success": true, "data": [...], "meta": {...}}

``data`` is expected to be a response DTO (a pydantic model from some
``dto/*_response.py``) or a list of them. ``jsonable_encoder`` serializes
models by alias, which is how the DTOs' snake_case fields become the
camelCase keys on the wire.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse


def send_success(data: Any, status: int = 200, meta: Mapping[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"success": True, "data": jsonable_encoder(data)}
    if meta is not None:
        body["meta"] = jsonable_encoder(meta)
    return JSONResponse(status_code=status, content=body)


def send_paginated(data: Sequence[Any], meta: Mapping[str, Any]) -> JSONResponse:
    return send_success(list(data), 200, meta)
