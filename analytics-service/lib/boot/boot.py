"""The composition root: every singleton in the process is constructed here.

This is where the Node services use a DI container (``tsyringe`` +
``container.ts``). Python needs no framework for it — a constructor is
already an injection point — so wiring is plain code, top to bottom, in
dependency order:

    env -> logger -> mongo -> repositories -> services -> controllers
        -> core client -> rbac -> broker -> consumer -> http app -> serve

Reading ``_serve`` tells you every object that exists and what it was given.
Adding a module means adding its wiring here; ``cmd/api/main.py`` never
changes. Like ``container.ts``, this is the one file in ``lib/`` allowed to
import ``app/`` — something has to put the two together.
"""

import asyncio
import sys
from typing import Any

import uvicorn
from fastapi import APIRouter, FastAPI
from pydantic import ValidationError

from app.analytics.controller.analytics_controller import AnalyticsController
from app.analytics.controller.routes import build_router as build_analytics_router
from app.analytics.eventhandlers.handlers import build_handlers
from app.analytics.repository.agg_restaurant_day_repo import AggRestaurantDayRepo
from app.analytics.repository.event_ids_repo import EventIDsRepo
from app.analytics.repository.indexes import ensure_indexes
from app.analytics.service.analytics_service import AnalyticsService
from app.health.routes import build_health_router
from lib.auth.middleware import Authenticate
from lib.boot.server import GracefulServer
from lib.config.env import Env, load
from lib.coreclient.client import CoreClient
from lib.coreclient.rbac import CoreRbacClient
from lib.coreevents.consumer import EventConsumer
from lib.errors import handler as errors
from lib.logger.logger import configure, logger
from lib.middleware.correlation import AccessLogMiddleware, CorrelationMiddleware
from lib.rbac.cache import PermissionsCache
from lib.rbac.middleware import Rbac
from pkg.httpclient.client import HttpClient
from pkg.httpclient.types import HttpClientConfig
from pkg.messaging.amqp import AmqpBroker
from pkg.messaging.types import AmqpConfig, ConnectionState, ConsumerOptions
from pkg.mongo.client import MongoClient
from pkg.mongo.types import MongoConfig

SERVICE_NAME = "analytics-service"
API_PREFIX = "/api/v1/analytics"
RABBIT_RETRY_MAX_SEC = 30.0


def run() -> None:
    """Process entry point. Blocks until the service has shut down."""
    try:
        env = load()
    except ValidationError as exc:
        configure()
        logger.error(
            "invalid environment",
            errors=[f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()],
        )
        sys.exit(1)

    configure(env.log_level)
    try:
        asyncio.run(_serve(env))
    except KeyboardInterrupt:
        # A Ctrl+C before the HTTP server took over signal handling (i.e. while
        # still connecting); _serve's finally has already cleaned up.
        pass


async def _serve(env: Env) -> None:
    mongo = MongoClient(
        MongoConfig(
            uri=env.mongo.uri,
            database=env.mongo.database,
            server_selection_timeout_ms=env.mongo.server_selection_timeout_ms,
            app_name=SERVICE_NAME,
        )
    )
    http_client = HttpClient(HttpClientConfig(base_url=env.core.base_url, timeout_sec=env.core.timeout_sec))
    broker = AmqpBroker(AmqpConfig(url=env.rabbit.url, on_state_change=_log_broker_state))
    consumer: EventConsumer | None = None
    rabbit_retry: asyncio.Task[None] | None = None

    try:
        # ---- storage ----
        db = await mongo.connect()
        logger.info("mongo connected", db=env.mongo.database)
        await ensure_indexes(db, event_ids_ttl_sec=env.rabbit.dedupe_ttl_sec)
        logger.info("mongo indexes ensured")

        # ---- app/analytics ----
        analytics_service = AnalyticsService(AggRestaurantDayRepo(db), env.analytics.max_range_days)
        analytics_controller = AnalyticsController(analytics_service)

        # ---- auth + rbac (permissions read through from core) ----
        core = CoreClient(http_client, env.core.internal_api_key)
        permissions = PermissionsCache(CoreRbacClient(core), ttl_sec=env.rbac.cache_ttl_sec)
        rbac = Rbac(Authenticate(env.jwt.access_secret), permissions)

        # ---- inbound events ----
        consumer = EventConsumer(
            broker,
            ConsumerOptions(
                exchange=env.rabbit.exchange,
                queue=env.rabbit.queue,
                binding_keys=env.rabbit.bindings,
                prefetch=env.rabbit.prefetch,
                dead_letter_exchange=env.rabbit.dlx,
                dead_letter_queue=env.rabbit.dlq,
            ),
            deduper=EventIDsRepo(db),
            handlers=build_handlers(analytics_service),
            logger=logger,
        )
        rabbit_retry = await _start_consumer(broker, consumer)

        # ---- http ----
        app = _create_app(
            health=build_health_router(mongo.ping, broker.is_connected),
            analytics=build_analytics_router(analytics_controller, rbac),
        )
        server = GracefulServer(
            uvicorn.Config(
                app,
                host="0.0.0.0",
                port=env.http.port,
                log_config=None,  # keep uvicorn's records on our JSON handler
                access_log=False,  # AccessLogMiddleware writes a better one
                lifespan="off",  # startup/shutdown is this function, not ASGI lifespan
            )
        )
        serving = asyncio.create_task(server.serve())
        # uvicorn signals "bound and accepting" only through this bool — there
        # is no event to await — so poll it. Ends early if serve() failed.
        while not server.started and not serving.done():  # noqa: ASYNC110
            await asyncio.sleep(0.05)
        if server.started:
            logger.info("http listening", port=env.http.port)
        await serving
        logger.info("shutdown requested")
    finally:
        await _shutdown(mongo, http_client, broker, consumer, rabbit_retry)


def _create_app(*, health: APIRouter, analytics: APIRouter) -> FastAPI:
    app = FastAPI(title=SERVICE_NAME, version="0.1.0")
    errors.install(app, logger)

    # Middleware: the first added is the innermost. Request path:
    #   Correlation -> AccessLog -> ErrorBoundary -> (FastAPI routing)
    errors.wrap(app, logger)
    app.add_middleware(AccessLogMiddleware, logger=logger)
    app.add_middleware(CorrelationMiddleware)

    app.include_router(health)
    app.include_router(analytics, prefix=API_PREFIX)
    return app


async def _start_consumer(broker: AmqpBroker, consumer: EventConsumer) -> asyncio.Task[None] | None:
    """Start consuming now if RabbitMQ is up; otherwise keep retrying in the
    background and let HTTP serve meanwhile. Reads do not need the broker,
    so a broker outage at boot must not take the read API down with it."""
    try:
        await broker.connect()
        await consumer.start()
        return None
    except Exception as exc:
        logger.warn(
            "rabbit not reachable at boot — retrying in background", error=str(exc) or type(exc).__name__
        )
        return asyncio.create_task(_retry_consumer(broker, consumer))


async def _retry_consumer(broker: AmqpBroker, consumer: EventConsumer) -> None:
    delay = 1.0
    while True:
        await asyncio.sleep(delay)
        try:
            await broker.connect()
            await consumer.start()
            return
        except Exception as exc:
            delay = min(delay * 2, RABBIT_RETRY_MAX_SEC)
            logger.warn("rabbit still not reachable", error=str(exc) or type(exc).__name__, retryInSec=delay)


async def _shutdown(
    mongo: MongoClient,
    http_client: HttpClient,
    broker: AmqpBroker,
    consumer: EventConsumer | None,
    rabbit_retry: asyncio.Task[None] | None,
) -> None:
    """Reverse boot order: stop taking work, finish what is in flight, then
    close the things that work needed. Each step is isolated so one failure
    does not leave the rest open."""
    if rabbit_retry is not None:
        rabbit_retry.cancel()
    if consumer is not None and broker.is_connected():
        await _quietly("consumer stop", consumer.stop())
    await _quietly("broker close", broker.close())
    await _quietly("http client close", http_client.aclose())
    await _quietly("mongo close", mongo.close())
    logger.info("shutdown complete")


async def _quietly(step: str, awaitable: Any) -> None:
    try:
        await awaitable
    except Exception as exc:
        logger.warn("shutdown step failed", step=step, error=str(exc))


def _log_broker_state(state: ConnectionState, detail: str | None) -> None:
    if state == "connected":
        logger.info("rabbit connected")
    else:
        logger.warn("rabbit disconnected — reconnecting", error=detail)
