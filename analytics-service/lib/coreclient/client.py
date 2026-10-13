"""Sync HTTP client to core-service — order-service's ``core-client.ts``.

Adds what every core call needs on top of ``pkg/httpclient``: the
``x-api-key`` header, the caller's correlation id, unwrapping core's
``{success, data}`` envelope, and turning transport failures into
``AppError``s the error handler knows how to render.
"""

from collections.abc import Mapping
from typing import Any

from lib.appcontext.context import correlation_id
from lib.coreclient.errors import ERR_CORE_BAD_RESPONSE, ERR_CORE_UNAVAILABLE
from pkg.httpclient.client import HttpClient
from pkg.httpclient.errors import HttpStatusError, HttpUnavailableError


class CoreClient:
    def __init__(self, http: HttpClient, api_key: str) -> None:
        self._http = http
        self._api_key = api_key

    async def call(self, method: str, path: str, *, params: Mapping[str, str] | None = None) -> Any:
        """Returns core's ``data``. Raises ``AppError`` — never an httpx error."""
        # Header name is the one core's api-key.guard.ts reads. Core hashes the
        # value and looks it up in its api_keys table, so it must match a key
        # core has seeded, verbatim.
        headers = {"x-api-key": self._api_key}
        cid = correlation_id()
        if cid:
            headers["X-CorrelationId"] = cid

        try:
            body = await self._http.request_json(method, path, params=params, headers=headers)
        except HttpUnavailableError as exc:
            raise ERR_CORE_UNAVAILABLE.with_details(reason=exc.reason) from exc
        except HttpStatusError as exc:
            raise ERR_CORE_BAD_RESPONSE.with_details(upstreamStatus=exc.status) from exc

        if not isinstance(body, dict) or "data" not in body:
            raise ERR_CORE_BAD_RESPONSE
        return body["data"]
