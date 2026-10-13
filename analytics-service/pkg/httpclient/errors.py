from typing import Any


class HttpClientError(Exception):
    """Base for everything ``HttpClient`` raises."""


class HttpUnavailableError(HttpClientError):
    """The upstream could not answer: a 5xx, a timeout or a transport failure,
    still failing after every retry. Retrying later may help."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"{url}: {reason}")
        self.url = url
        self.reason = reason


class HttpStatusError(HttpClientError):
    """The upstream answered with a 4xx. Not retried — asking again will get
    the same answer. ``body`` is the parsed JSON, or the raw text if it was
    not JSON, so callers can read structured error details."""

    def __init__(self, url: str, status: int, body: Any) -> None:
        super().__init__(f"{url}: HTTP {status}")
        self.url = url
        self.status = status
        self.body = body
