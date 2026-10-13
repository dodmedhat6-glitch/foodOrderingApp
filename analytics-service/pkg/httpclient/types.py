from dataclasses import dataclass


@dataclass(frozen=True)
class HttpClientConfig:
    base_url: str
    timeout_sec: float = 3.0
    #: Total tries for a retryable failure (5xx, timeout, transport error).
    attempts: int = 3
    initial_backoff_sec: float = 0.05
    max_backoff_sec: float = 0.5
