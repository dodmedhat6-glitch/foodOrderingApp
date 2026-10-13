from dataclasses import dataclass

PERM_ANALYTICS_READ = "analytics:read"
ORDER_PLACED = "order.placed"  # routing key = event type (order-service lib/events/event-types.ts)


@dataclass(frozen=True)
class AggRestaurantDay:
    """One `agg_restaurant_day` document: a restaurant's activity on one UTC day.

    Averages are stored as sum + count, never as an average, so partial days
    (replays, backfills) merge by addition. The read path derives the average.
    """

    restaurant_id: int
    date: str  # "YYYY-MM-DD" UTC — a bucket label; string order == date order
    currency: str
    orders_count: int
    revenue_sum: int  # integer minor units
