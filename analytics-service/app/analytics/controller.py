"""The event way into the analytics service.
Thin — validated payload in, one service call, nothing else."""

from pydantic import ValidationError

from app.analytics.dto import OrderPlacedPayload
from app.analytics.errors import ERR_INVALID_EVENT_PAYLOAD
from app.analytics.service import AnalyticsService
from app.analytics.types import ORDER_PLACED
from lib.events import EventHandler


def build_handlers(service: AnalyticsService) -> dict[str, EventHandler]:
    async def on_order_placed(payload: dict[str, object]) -> None:
        try:
            event = OrderPlacedPayload.model_validate(payload)
        except ValidationError as exc:
            raise ERR_INVALID_EVENT_PAYLOAD.with_details(errors=exc.errors(include_url=False)) from exc
        await service.on_order_placed(event)

    return {ORDER_PLACED: on_order_placed}
