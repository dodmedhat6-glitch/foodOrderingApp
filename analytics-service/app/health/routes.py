"""``GET /health`` — liveness plus a cheap look at each dependency.

Always 200 while the process can answer: a load balancer that pulls this
replica because RabbitMQ blinked would take the read API down with it, and
reads do not need RabbitMQ. ``status: "degraded"`` says something is off.
"""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.health.dto.health_response import HealthResponse
from lib.http.response import send_success

Probe = Callable[[], Awaitable[bool]]


def build_health_router(mongo_up: Probe, rabbit_up: Callable[[], bool]) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health() -> JSONResponse:
        mongo_ok = await mongo_up()
        rabbit_ok = rabbit_up()
        return send_success(
            HealthResponse(
                status="ok" if mongo_ok and rabbit_ok else "degraded",
                mongo="up" if mongo_ok else "down",
                rabbit="up" if rabbit_ok else "down",
            )
        )

    return router
