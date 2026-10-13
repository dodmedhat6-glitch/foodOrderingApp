from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class AggRestaurantDay:
    """One ``agg_restaurant_day`` document: a restaurant's activity on one UTC day.

    Plain data. No pymongo types, no ``_id``, no methods that touch the
    database — the repository maps documents to and from this explicitly.

    Averages are stored as ``sum`` + ``count``, never as an average: two
    partial days (say, a live stream and a backfill) merge by adding their
    sums and counts, and the same is true for any number of replays. An
    average of averages is wrong; a sum of sums is not.
    """

    restaurant_id: int
    #: ``YYYY-MM-DD`` in UTC. A string, not a datetime: it is a bucket label,
    #: and string comparison on this format sorts and range-filters correctly.
    date: str
    currency: str
    orders_count: int
    #: Integer minor units (piasters, halalas). Never a float.
    revenue_sum: int
    #: Placed → delivered, filled by the ``order.delivered`` handler (homework).
    delivery_ms_sum: int
    delivery_ms_count: int
    updated_at: datetime
