"""Event type -> service method.

Handlers are thin, exactly like controllers (order-service CLAUDE.md
§Handler structure): parse the payload into a typed input, call one service
method, nothing else. ``build_handlers`` is the registration — the consumer
in ``lib/coreevents`` receives the dict and never imports this module.
"""

from collections.abc import Mapping
from datetime import UTC
from typing import Any

from pydantic import ValidationError

from app.analytics.enums import OrderEventType
from app.analytics.errors import ERR_INVALID_EVENT_PAYLOAD
from app.analytics.eventhandlers.payloads import OrderPlacedPayload
from app.analytics.service.analytics_service import AnalyticsService
from app.analytics.types import OnOrderPlacedInput
from lib.coreevents.payloads import EventHandler, EventMeta


def build_handlers(service: AnalyticsService) -> dict[str, EventHandler]:
    async def on_order_placed(payload: Mapping[str, Any], _meta: EventMeta) -> None:
        try:
            event = OrderPlacedPayload.model_validate(payload)
        except ValidationError as exc:
            raise ERR_INVALID_EVENT_PAYLOAD.with_details(errors=exc.errors(include_url=False)) from exc

        await service.on_order_placed(
            OnOrderPlacedInput(
                order_id=event.orderId,
                restaurant_id=event.restaurantId,
                branch_id=event.branchId,
                # The bucket is the UTC calendar day, whatever offset the
                # timestamp was written with.
                day=event.placedAt.astimezone(UTC).date(),
                currency=event.currency,
                total_minor=event.total,
            )
        )

    return {
        OrderEventType.ORDER_PLACED: on_order_placed,
    }
