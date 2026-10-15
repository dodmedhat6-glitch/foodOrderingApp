"""Typed environment — order-service's `lib/config/env.ts`.

Every variable is a field here (env var `MONGO_URI` -> `env.mongo_uri`) and is
validated at boot: a missing required value stops the process before anything
connects. Nothing else in the service reads `os.environ`.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Env(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parents[1] / ".env", extra="ignore")

    port: int = 4100
    log_level: str = "INFO"

    access_secret: str  # required — must equal core's and order-service's

    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db: str = "quickbite_analytics"

    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"
    rabbitmq_order_events_exchange: str = "order.events"
    rabbitmq_order_events_queue: str = "analytics-service.order-events"
    rabbitmq_order_events_bindings: str = "order.#,payment.#"  # comma-separated
    rabbitmq_order_events_dlx: str = "analytics-service.order-events.dlx"
    rabbitmq_order_events_dlq: str = "analytics-service.order-events.dlq"
    rabbitmq_prefetch: int = 32
    event_dedupe_ttl_days: int = 7

    core_service_base_url: str  # required
    core_internal_api_key: str  # required
    core_timeout_ms: int = 3000
    rbac_cache_ttl_sec: int = 300

    analytics_max_range_days: int = 366
