"""Route table for the analytics module — the ``routes.ts`` of the Node modules.

Reads top to bottom like an Express route: path, guards in order, handler.
The guards are FastAPI dependencies (``lib/auth``, ``lib/rbac``); the handler
is a small function that only adapts FastAPI's parameter injection to the
controller method. Mounted under ``/api/v1/analytics`` by ``lib/boot``.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse

from app.analytics.controller.analytics_controller import AnalyticsController
from app.analytics.dto.restaurant_days_request import RestaurantDaysQuery
from app.analytics.enums import PERM_ANALYTICS_READ
from lib.rbac.middleware import Rbac


def build_router(controller: AnalyticsController, rbac: Rbac) -> APIRouter:
    router = APIRouter()

    # GET /api/v1/analytics/restaurants/{restaurantId}/days?from=&to=
    # authenticate (via both guards) -> member of this restaurant -> analytics:read
    @router.get(
        "/restaurants/{restaurantId}/days",
        dependencies=[
            Depends(rbac.require_restaurant_member()),
            Depends(rbac.require(PERM_ANALYTICS_READ)),
        ],
    )
    async def get_restaurant_days(
        restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        query: Annotated[RestaurantDaysQuery, Query()],
    ) -> JSONResponse:
        return await controller.get_restaurant_days(restaurant_id, query)

    return router
