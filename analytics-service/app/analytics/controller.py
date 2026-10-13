"""The two ways into the analytics service: HTTP routes and event handlers.
Both are thin — validated input in, one service call, nothing else."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.analytics.dto import OrderPlacedPayload, RestaurantDaysQuery
from app.analytics.errors import ERR_INVALID_EVENT_PAYLOAD
from app.analytics.service import AnalyticsService
from app.analytics.types import ORDER_PLACED, PERM_ANALYTICS_READ
from lib.auth import Auth
from lib.events import EventHandler
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


def build_handlers(service: AnalyticsService) -> dict[str, EventHandler]:
    async def on_order_placed(payload: dict[str, object]) -> None:
        try:
            event = OrderPlacedPayload.model_validate(payload)
        except ValidationError as exc:
            raise ERR_INVALID_EVENT_PAYLOAD.with_details(errors=exc.errors(include_url=False)) from exc
        await service.on_order_placed(event)

    return {ORDER_PLACED: on_order_placed}
