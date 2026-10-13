from datetime import date

from app.analytics.entity.agg_restaurant_day import AggRestaurantDay
from app.analytics.errors import ERR_DATE_RANGE_TOO_LARGE, ERR_INVALID_DATE_RANGE
from app.analytics.repository.agg_restaurant_day_repo import AggRestaurantDayRepo
from app.analytics.types import DateRange, OnOrderPlacedInput, RestaurantDayRow
from lib.logger.logger import from_context


class AnalyticsService:
    """The analytics module's business logic: write side (event -> rollup)
    and read side (rollup -> rows with derived figures).

    Constructed once in ``lib/boot`` with everything it needs. It raises
    ``AppError``s and returns plain types; it knows nothing about HTTP,
    AMQP, or which of the two called it.
    """

    def __init__(self, restaurant_days: AggRestaurantDayRepo, max_range_days: int) -> None:
        self._restaurant_days = restaurant_days
        self._max_range_days = max_range_days

    # ---- write side (called by eventhandlers) ----

    async def on_order_placed(self, data: OnOrderPlacedInput) -> None:
        await self._restaurant_days.add_placed_order(
            restaurant_id=data.restaurant_id,
            day=data.day.isoformat(),
            currency=data.currency,
            total_minor=data.total_minor,
        )
        from_context().debug(
            "restaurant day updated", restaurantId=data.restaurant_id, day=data.day.isoformat()
        )

    # ---- read side (called by controllers) ----

    async def get_restaurant_days(self, restaurant_id: int, period: DateRange) -> list[RestaurantDayRow]:
        """Days with activity in the period, oldest first. Days with none are
        absent, not zero-filled: the client knows the calendar, we know the data."""
        self._assert_range(period)
        days = await self._restaurant_days.find_range(
            restaurant_id, period.start.isoformat(), period.end.isoformat()
        )
        return [_to_row(day) for day in days]

    def _assert_range(self, period: DateRange) -> None:
        if period.start > period.end:
            raise ERR_INVALID_DATE_RANGE
        span = (period.end - period.start).days + 1
        if span > self._max_range_days:
            raise ERR_DATE_RANGE_TOO_LARGE.with_details(maxDays=self._max_range_days, requestedDays=span)


def _to_row(day: AggRestaurantDay) -> RestaurantDayRow:
    """Stored sums -> what the client asked for. The average is derived here,
    in the service, every time — never stored (see AggRestaurantDay)."""
    return RestaurantDayRow(
        day=date.fromisoformat(day.date),
        orders_count=day.orders_count,
        revenue_minor=day.revenue_sum,
        currency=day.currency,
        avg_order_minor=_div_round_half_up(day.revenue_sum, day.orders_count),
    )


def _div_round_half_up(total: int, count: int) -> int:
    """Integer average in minor units, .5 rounded up — exact, no floats.

    ``round()`` would round half to *even* (``round(2.5) == 2``), which is
    right for statistics and surprising on a money figure. A day with no
    orders (possible once ``order.delivered`` can arrive first) averages 0.
    """
    if count <= 0:
        return 0
    return (2 * total + count) // (2 * count)
