from datetime import UTC, date

from app.analytics.dto import OrderPlacedPayload, RestaurantDayResponse
from app.analytics.errors import ERR_DATE_RANGE_TOO_LARGE, ERR_INVALID_DATE_RANGE
from app.analytics.repository import AggRestaurantDayRepo


class AnalyticsService:
    """Business logic for both directions: event -> rollup, rollup -> response.
    Knows nothing about HTTP or AMQP; raises AppError."""

    def __init__(self, restaurant_days: AggRestaurantDayRepo, max_range_days: int) -> None:
        self._restaurant_days = restaurant_days
        self._max_range_days = max_range_days

    async def on_order_placed(self, event: OrderPlacedPayload) -> None:
        # Bucket by when the order was placed (UTC), not when we processed it:
        # a message delayed by an outage still lands on the right day.
        day = event.placedAt.astimezone(UTC).date().isoformat()
        await self._restaurant_days.add_placed_order(event.restaurantId, day, event.currency, event.total)

    async def get_restaurant_days(
        self, restaurant_id: int, start: date, end: date
    ) -> list[RestaurantDayResponse]:
        """Days with activity, oldest first. Sparse: a day with no orders is absent, not zero."""
        if start > end:
            raise ERR_INVALID_DATE_RANGE
        span = (end - start).days + 1
        if span > self._max_range_days:
            raise ERR_DATE_RANGE_TOO_LARGE.with_details(maxDays=self._max_range_days, requestedDays=span)
        days = await self._restaurant_days.find_range(restaurant_id, start.isoformat(), end.isoformat())
        return [RestaurantDayResponse.from_entity(day) for day in days]
