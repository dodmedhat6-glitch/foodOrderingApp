"""Wire shapes: the HTTP request/response DTOs and the inbound event payload.

Python fields are snake_case; the wire is camelCase via aliases.
"""

import re
from datetime import date
from typing import Any, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from app.analytics.types import AggRestaurantDay

_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class RestaurantDaysQuery(BaseModel):
    """`?from=YYYY-MM-DD&to=YYYY-MM-DD` — required, inclusive, UTC. `from <= to` is checked in the service."""

    from_: date = Field(alias="from")
    to: date

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _iso_day_only(cls, value: Any) -> Any:
        # pydantic's lax `date` would also take "1760000000" (a unix timestamp).
        if isinstance(value, str) and not _ISO_DAY.match(value):
            raise ValueError("must be a date in YYYY-MM-DD format")
        return value


class RestaurantDayResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    date: str
    orders_count: int
    revenue_minor: int
    currency: str
    avg_order_minor: int

    @classmethod
    def from_entity(cls, day: AggRestaurantDay) -> Self:
        return cls(
            date=day.date,
            orders_count=day.orders_count,
            revenue_minor=day.revenue_sum,
            currency=day.currency,
            # Derived here, never stored. Integer half-up: round() is banker's
            # rounding (round(2.5) == 2), and floats have no place near money.
            avg_order_minor=(2 * day.revenue_sum + day.orders_count) // (2 * day.orders_count)
            if day.orders_count > 0
            else 0,
        )


class OrderPlacedPayload(BaseModel):
    """`order.placed` payload — mirrors order-service's `OrderPlacedPayload` (lib/events/types.ts).
    Only the fields this service reads are declared; the rest are ignored."""

    orderId: str
    restaurantId: int = Field(gt=0)
    branchId: int = Field(gt=0)
    total: int = Field(ge=0, strict=True)  # minor units; 2500.0 is a contract break, not 2500
    currency: str = Field(min_length=3, max_length=3)
    placedAt: AwareDatetime  # must carry an offset: a naive timestamp has no defined UTC day
