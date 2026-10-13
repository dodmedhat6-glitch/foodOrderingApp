"""A small JSON-over-HTTP client: timeout, retry on 5xx, typed errors.

The Python twin of order-service's ``CoreClient.request`` + ``pkg/utils/retry.ts``,
minus everything core-specific (the api-key header, the ``{success, data}``
envelope) — that belongs to ``lib/coreclient``, which wraps this.
"""

import asyncio
import json
from collections.abc import Mapping
from typing import Any

import httpx

from pkg.httpclient.errors import HttpStatusError, HttpUnavailableError
from pkg.httpclient.types import HttpClientConfig


class HttpClient:
    def __init__(self, config: HttpClientConfig, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._config = config
        # One pooled client for the process — opening an AsyncClient per call
        # throws away keep-alive and costs a TCP (and TLS) handshake each time.
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            timeout=config.timeout_sec,
            transport=transport,
        )

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        json_body: Any = None,
    ) -> Any:
        """Send, retry what is worth retrying, return the decoded JSON body.

        Raises ``HttpStatusError`` for a 4xx (never retried) and
        ``HttpUnavailableError`` once retries are exhausted.
        """
        url = f"{self._config.base_url}{path}"
        delay = self._config.initial_backoff_sec
        last_reason = "no attempt made"

        for attempt in range(1, self._config.attempts + 1):
            try:
                res = await self._client.request(method, path, params=params, headers=headers, json=json_body)
            except httpx.TransportError as exc:  # timeouts, refused, reset, DNS
                last_reason = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
            else:
                if res.status_code < 500:
                    if res.status_code >= 400:
                        raise HttpStatusError(url, res.status_code, _decode(res))
                    return _decode(res) if res.status_code != 204 else None
                last_reason = f"HTTP {res.status_code}"

            if attempt < self._config.attempts:
                await asyncio.sleep(delay)
                delay = min(delay * 2, self._config.max_backoff_sec)

        raise HttpUnavailableError(url, last_reason)

    async def aclose(self) -> None:
        await self._client.aclose()


def _decode(res: httpx.Response) -> Any:
    try:
        return res.json()
    except json.JSONDecodeError:
        return res.text
