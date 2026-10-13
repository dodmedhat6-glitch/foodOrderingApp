"""analytics-service process — order-service's `server.ts` + `app.ts` + `routes.ts` in one file.

    python server.py        (from the service root)

Builds every object in dependency order (no DI framework: a constructor is the
injection point), serves HTTP, consumes events, and shuts down in reverse.
"""

import asyncio
import contextlib
import signal
import sys
import threading
from collections.abc import Generator
from typing import Any

import uvicorn
from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from pymongo import AsyncMongoClient
from uvicorn.server import HANDLED_SIGNALS

from app.analytics.controller import build_handlers, build_router
from app.analytics.repository import AggRestaurantDayRepo, EventIdsRepo, ensure_indexes
from app.analytics.service import AnalyticsService
from lib.auth import Auth, PermissionsCache
from lib.config import Env
from lib.core_client import CoreClient
from lib.errors import install_error_handlers
from lib.events import EventConsumer
from lib.http import RequestMiddleware, send_success
from lib.logger import configure, logger
from pkg.messaging import AmqpBroker, ConsumerOptions


def create_app(mongo: AsyncMongoClient[dict[str, Any]], broker: AmqpBroker, router: APIRouter) -> FastAPI:
    app = FastAPI(title="analytics-service")
    install_error_handlers(app)
    app.add_middleware(RequestMiddleware)

    @app.get("/health")
    async def health() -> JSONResponse:
        # Always 200 while we can answer: reads don't need RabbitMQ, so a broker blip
        # must not get this replica pulled from the load balancer.
        try:
            await mongo.admin.command("ping")
            mongo_up = True
        except Exception:
            mongo_up = False
        rabbit_up = broker.is_connected()
        return send_success(
            {
                "status": "ok" if mongo_up and rabbit_up else "degraded",
                "mongo": "up" if mongo_up else "down",
                "rabbit": "up" if rabbit_up else "down",
            }
        )

    app.include_router(router)
    return app


async def main() -> None:
    env = Env()
    configure(env.log_level)

    mongo: AsyncMongoClient[dict[str, Any]] = AsyncMongoClient(
        env.mongo_uri, serverSelectionTimeoutMS=5000, tz_aware=True, appname="analytics-service"
    )
    core = CoreClient(env.core_service_base_url, env.core_internal_api_key, env.core_timeout_ms / 1000)
    broker = AmqpBroker(env.rabbitmq_url, on_state_change=_log_broker_state)
    consumer: EventConsumer | None = None
    rabbit_retry: asyncio.Task[None] | None = None

    try:
        await mongo.admin.command("ping")  # the client itself does no I/O; fail boot here, not on request 1
        logger.info("mongo connected", db=env.mongo_db)
        db = mongo[env.mongo_db]
        await ensure_indexes(db, event_ids_ttl_sec=env.event_dedupe_ttl_days * 86400)

        service = AnalyticsService(AggRestaurantDayRepo(db), env.analytics_max_range_days)
        auth = Auth(env.access_secret, PermissionsCache(core.get_role_permissions, env.rbac_cache_ttl_sec))
        consumer = EventConsumer(
            broker,
            ConsumerOptions(
                exchange=env.rabbitmq_order_events_exchange,
                queue=env.rabbitmq_order_events_queue,
                binding_keys=[k.strip() for k in env.rabbitmq_order_events_bindings.split(",") if k.strip()],
                prefetch=env.rabbitmq_prefetch,
                dead_letter_exchange=env.rabbitmq_order_events_dlx,
                dead_letter_queue=env.rabbitmq_order_events_dlq,
            ),
            EventIdsRepo(db),
            build_handlers(service),
        )
        # A broker that's down at boot must not take the read API down with it:
        # keep retrying in the background while HTTP serves.
        if not await _start_consumer(broker, consumer):
            rabbit_retry = asyncio.create_task(_retry_consumer(broker, consumer))

        server = _Server(
            uvicorn.Config(
                create_app(mongo, broker, build_router(service, auth)),
                host="0.0.0.0",
                port=env.port,
                log_config=None,
                access_log=False,
                lifespan="off",
            )
        )
        serving = asyncio.create_task(server.serve())
        while not server.started and not serving.done():  # noqa: ASYNC110 — uvicorn only exposes a bool
            await asyncio.sleep(0.05)
        if server.started:
            logger.info("http listening", port=env.port)
        await serving
        logger.info("shutdown requested")
    finally:
        if rabbit_retry is not None:
            rabbit_retry.cancel()
        if consumer is not None and broker.is_connected():
            await consumer.stop()
        await broker.close()
        await core.aclose()
        await mongo.close()
        logger.info("shutdown complete")


async def _start_consumer(broker: AmqpBroker, consumer: EventConsumer) -> bool:
    try:
        await broker.connect()
        await consumer.start()
        return True
    except Exception as exc:
        logger.warn("rabbit not reachable — retrying", error=str(exc) or type(exc).__name__)
        return False


async def _retry_consumer(broker: AmqpBroker, consumer: EventConsumer) -> None:
    delay = 1.0
    while True:
        await asyncio.sleep(delay)
        if await _start_consumer(broker, consumer):
            return
        delay = min(delay * 2, 30)


def _log_broker_state(state: str, detail: str | None) -> None:
    if state == "connected":
        logger.info("rabbit connected")
    else:
        logger.warn("rabbit disconnected — reconnecting", error=detail)


class _Server(uvicorn.Server):
    """uvicorn re-raises SIGINT/SIGTERM after its own shutdown, which would interrupt
    ours (consumer drain, broker, Mongo) in `main`'s finally. Same handling, no re-raise."""

    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None]:
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        original = {sig: signal.signal(sig, self.handle_exit) for sig in HANDLED_SIGNALS}
        try:
            yield
        finally:
            for sig, handler in original.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ValidationError as exc:
        configure()
        logger.error("invalid environment", errors=[f"{e['loc'][0]}: {e['msg']}" for e in exc.errors()])
        sys.exit(1)
    except KeyboardInterrupt:
        pass  # Ctrl+C while still connecting; main's finally already cleaned up
