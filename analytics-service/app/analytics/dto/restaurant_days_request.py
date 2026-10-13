import re
from datetime import date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.analytics.types import DateRange

_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class RestaurantDaysQuery(BaseModel):
    """``?from=YYYY-MM-DD&to=YYYY-MM-DD`` — both required, both inclusive, UTC days.

    The Python counterpart of a class-validator request DTO, used as a FastAPI
    query-parameter model: FastAPI validates the query string against it before
    the controller runs, and a failure becomes a 400 ``VALIDATION_ERROR``.

    ``from`` is a Python keyword, hence ``from_`` with an alias. Cross-field
    rules (``from <= to``, maximum span) are *business* rules and live in the
    service, which raises the module's own error codes for them.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    from_: date = Field(alias="from", description="First day, YYYY-MM-DD (UTC)")
    to: date = Field(description="Last day, YYYY-MM-DD (UTC)")

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _strict_iso_day(cls, value: Any) -> Any:
        # pydantic's lax `date` also accepts e.g. "1760000000" (a unix
        # timestamp) or a full datetime. A day bucket is exactly YYYY-MM-DD.
        if isinstance(value, str) and not _ISO_DAY.match(value):
            raise ValueError("must be a date in YYYY-MM-DD format")
        return value

    def to_range(self) -> DateRange:
        return DateRange(start=self.from_, end=self.to)
