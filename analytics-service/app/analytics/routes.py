"""The HTTP way into the analytics service.
Thin — validated input in, one service call, nothing else."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse

from app.analytics.dto import RestaurantDaysQuery
from app.analytics.service import AnalyticsService
from app.analytics.types import PERM_ANALYTICS_READ
from lib.auth import Auth
from lib.http import send_success


def build_router(service: AnalyticsService, auth: Auth) -> APIRouter:
    router = APIRouter(prefix="/api/v1/analytics")

    # authenticate -> member of this restaurant -> analytics:read
    @router.get(
        "/restaurants/{restaurantId}/days",
        dependencies=[Depends(auth.require_restaurant_member()), Depends(auth.require(PERM_ANALYTICS_READ))],
    )
    async def get_restaurant_days(
        restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        query: Annotated[RestaurantDaysQuery, Query()],
    ) -> JSONResponse:
        return send_success(await service.get_restaurant_days(restaurant_id, query.from_, query.to))

    return router
