from typing import Self

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.analytics.types import RestaurantDayRow


class RestaurantDayResponse(BaseModel):
    """One element of ``GET /restaurants/{id}/days``.

    Fields are snake_case in Python and camelCase on the wire —
    ``alias_generator=to_camel`` does the renaming, ``send_success``
    serializes by alias. Money in integer minor units with ``currency``
    beside it; ``date`` is the UTC day ``YYYY-MM-DD``.

    ``from_row`` is the only way one gets built, so nothing reaches the
    client that this class does not name — the Node services'
    ``XResponseDTO.from(entity)`` rule.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)

    date: str
    orders_count: int
    revenue_minor: int
    currency: str
    avg_order_minor: int

    @classmethod
    def from_row(cls, row: RestaurantDayRow) -> Self:
        return cls(
            date=row.day.isoformat(),
            orders_count=row.orders_count,
            revenue_minor=row.revenue_minor,
            currency=row.currency,
            avg_order_minor=row.avg_order_minor,
        )
