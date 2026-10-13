"""Sync HTTP client to core-service — order-service's `core-client.ts` + `rbac.client.ts`."""

import asyncio
from typing import Any
from urllib.parse import quote

import httpx

from lib.errors import AppError
from lib.logger import correlation_id

ERR_CORE_UNAVAILABLE = AppError("CORE_UNAVAILABLE", 503, "core-service is unavailable")
ERR_CORE_BAD_RESPONSE = AppError("CORE_BAD_RESPONSE", 502, "core-service returned an unexpected response")

_ATTEMPTS = 3


class CoreClient:
    def __init__(self, base_url: str, api_key: str, timeout_sec: float) -> None:
        # One pooled client per process: keep-alive instead of a new connection per call.
        self._http = httpx.AsyncClient(base_url=base_url, timeout=timeout_sec)
        self._api_key = api_key

    async def call(self, method: str, path: str) -> Any:
        """Core's `data`, unwrapped from `{success, data}`. Retries 5xx and transport errors; never a 4xx."""
        headers = {"x-api-key": self._api_key}  # the header core's api-key.guard.ts reads
        if cid := correlation_id.get():
            headers["X-CorrelationId"] = cid

        delay = 0.05
        for attempt in range(_ATTEMPTS):
            try:
                res = await self._http.request(method, path, headers=headers)
            except httpx.TransportError:
                res = None
            if res is not None and res.status_code < 500:
                if res.status_code >= 400:
                    raise ERR_CORE_BAD_RESPONSE.with_details(upstreamStatus=res.status_code)
                body = res.json()
                if not isinstance(body, dict) or "data" not in body:
                    raise ERR_CORE_BAD_RESPONSE
                return body["data"]
            if attempt < _ATTEMPTS - 1:
                await asyncio.sleep(delay)
                delay *= 2
        raise ERR_CORE_UNAVAILABLE

    async def get_role_permissions(self, role: str) -> frozenset[str]:
        """`GET /api/roles/{role}/permissions` — the route core serves; order-service reads the same one."""
        data = await self.call("GET", f"/api/roles/{quote(role, safe='')}/permissions")
        try:
            return frozenset(str(p["permission"]) for p in data["permissions"])
        except (KeyError, TypeError) as exc:
            raise ERR_CORE_BAD_RESPONSE from exc

    async def aclose(self) -> None:
        await self._http.aclose()
