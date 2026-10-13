"""Typed environment — the Python counterpart of order-service's zod-parsed ``env.ts``.

Two steps, same as the Node version:

1. ``_Settings`` is the *schema*: every variable, its type, its default.
   pydantic-settings reads ``os.environ`` and the service's ``.env``, coerces
   ``"4100"`` to ``4100``, and refuses to boot on a missing required value —
   ``baseSchema.parse(process.env)``.
2. ``load()`` reshapes the flat variables into the nested, frozen ``Env``
   the rest of the code reads (``env.rabbit.queue``, not ``RABBITMQ_..._QUEUE``).

Unlike the Node module, nothing is parsed at import time and there is no
module-level ``env`` singleton: ``lib/boot`` calls ``load()`` once and passes
the pieces each component needs into its constructor. A component that never
receives the env cannot quietly start depending on it.

Adding a variable = one field on ``_Settings`` + one line in ``load()`` + one
line in ``.env.example``. Never read ``os.environ`` anywhere else.
"""

from dataclasses import dataclass
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# analytics-service/.env, wherever the process was started from.
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class _Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore", case_sensitive=True)

    PORT: int = 4100
    LOG_LEVEL: str = "INFO"

    ACCESS_SECRET: str  # required — must equal core's and order-service's

    MONGO_URI: str = "mongodb://localhost:27017"
    MONGO_DB: str = "quickbite_analytics"
    MONGO_SERVER_SELECTION_TIMEOUT_MS: int = 5000

    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
    RABBITMQ_ORDER_EVENTS_EXCHANGE: str = "order.events"
    RABBITMQ_ORDER_EVENTS_QUEUE: str = "analytics-service.order-events"
    RABBITMQ_ORDER_EVENTS_BINDINGS: str = "order.#,payment.#"
    RABBITMQ_ORDER_EVENTS_DLX: str = "analytics-service.order-events.dlx"
    RABBITMQ_ORDER_EVENTS_DLQ: str = "analytics-service.order-events.dlq"
    RABBITMQ_PREFETCH: int = 32
    EVENT_DEDUPE_TTL_DAYS: int = 7

    CORE_SERVICE_BASE_URL: str  # required
    CORE_INTERNAL_API_KEY: str  # required
    CORE_TIMEOUT_MS: int = 3000
    RBAC_CACHE_TTL_SEC: int = 300

    INTERNAL_API_KEY: str = ""

    ANALYTICS_MAX_RANGE_DAYS: int = 366


@dataclass(frozen=True)
class HttpEnv:
    port: int


@dataclass(frozen=True)
class JwtEnv:
    access_secret: str


@dataclass(frozen=True)
class MongoEnv:
    uri: str
    database: str
    server_selection_timeout_ms: int


@dataclass(frozen=True)
class RabbitEnv:
    url: str
    exchange: str
    queue: str
    bindings: tuple[str, ...]
    dlx: str
    dlq: str
    prefetch: int
    dedupe_ttl_sec: int


@dataclass(frozen=True)
class CoreEnv:
    base_url: str
    internal_api_key: str
    timeout_sec: float


@dataclass(frozen=True)
class RbacEnv:
    cache_ttl_sec: int


@dataclass(frozen=True)
class AnalyticsEnv:
    max_range_days: int


@dataclass(frozen=True)
class Env:
    log_level: str
    http: HttpEnv
    jwt: JwtEnv
    mongo: MongoEnv
    rabbit: RabbitEnv
    core: CoreEnv
    rbac: RbacEnv
    internal_api_key: str
    analytics: AnalyticsEnv


def load() -> Env:
    """Parse and validate. Raises ``pydantic.ValidationError`` naming every bad variable."""
    # Required fields come from the environment, not kwargs — the pydantic
    # mypy plugin knows that about BaseSettings, so no type: ignore needed.
    s = _Settings()
    return Env(
        log_level=s.LOG_LEVEL.upper(),
        http=HttpEnv(port=s.PORT),
        jwt=JwtEnv(access_secret=s.ACCESS_SECRET),
        mongo=MongoEnv(
            uri=s.MONGO_URI,
            database=s.MONGO_DB,
            server_selection_timeout_ms=s.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        ),
        rabbit=RabbitEnv(
            url=s.RABBITMQ_URL,
            exchange=s.RABBITMQ_ORDER_EVENTS_EXCHANGE,
            queue=s.RABBITMQ_ORDER_EVENTS_QUEUE,
            bindings=_split_csv(s.RABBITMQ_ORDER_EVENTS_BINDINGS),
            dlx=s.RABBITMQ_ORDER_EVENTS_DLX,
            dlq=s.RABBITMQ_ORDER_EVENTS_DLQ,
            prefetch=s.RABBITMQ_PREFETCH,
            dedupe_ttl_sec=s.EVENT_DEDUPE_TTL_DAYS * 24 * 60 * 60,
        ),
        core=CoreEnv(
            base_url=s.CORE_SERVICE_BASE_URL.rstrip("/"),
            internal_api_key=s.CORE_INTERNAL_API_KEY,
            timeout_sec=s.CORE_TIMEOUT_MS / 1000,
        ),
        rbac=RbacEnv(cache_ttl_sec=s.RBAC_CACHE_TTL_SEC),
        internal_api_key=s.INTERNAL_API_KEY,
        analytics=AnalyticsEnv(max_range_days=s.ANALYTICS_MAX_RANGE_DAYS),
    )


def _split_csv(raw: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in raw.split(",") if part.strip())
