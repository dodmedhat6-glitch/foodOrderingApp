"""Types shared across the analytics subpackages (service, controller,
eventhandlers, repository). Entities live in ``entity/``; wire shapes in
``dto/``; these are the in-between values that are neither."""

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class OnOrderPlacedInput:
    """What ``AnalyticsService.on_order_placed`` needs from an ``order.placed``
    event — already parsed and validated by the event handler, so the service
    never sees a raw dict."""

    order_id: str
    restaurant_id: int
    branch_id: int
    #: The UTC calendar day the order was placed — the rollup bucket.
    day: date
    currency: str
    total_minor: int


@dataclass(frozen=True)
class DateRange:
    """Inclusive on both ends: ``from=2026-10-01&to=2026-10-01`` is one day."""

    start: date
    end: date


@dataclass(frozen=True)
class RestaurantDayRow:
    """One day of one restaurant, as the service returns it — stored sums
    plus the averages derived from them. The controller maps this to the
    response DTO; it never touches the entity."""

    day: date
    orders_count: int
    revenue_minor: int
    currency: str
    avg_order_minor: int
