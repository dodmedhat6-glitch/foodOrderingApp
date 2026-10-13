"""``agg_restaurant_day`` — the only place its documents are read or written.

Plain pymongo, no ODM: a mapper in each direction, a projection on every
read (the ``<MODULE>_COLUMNS`` rule from the Node services — never fetch a
whole document by default), and update operators that do the arithmetic on
the server.
"""

from datetime import UTC, datetime

from app.analytics.entity.agg_restaurant_day import AggRestaurantDay
from app.analytics.repository.collections import AGG_RESTAURANT_DAY
from pkg.mongo.types import Database, Document

_PROJECTION = {
    "_id": 0,
    "restaurant_id": 1,
    "date": 1,
    "currency": 1,
    "orders_count": 1,
    "revenue_sum": 1,
    "delivery_ms_sum": 1,
    "delivery_ms_count": 1,
    "updated_at": 1,
}


def _to_entity(doc: Document) -> AggRestaurantDay:
    return AggRestaurantDay(
        restaurant_id=int(doc["restaurant_id"]),
        date=str(doc["date"]),
        currency=str(doc.get("currency", "")),
        orders_count=int(doc.get("orders_count", 0)),
        revenue_sum=int(doc.get("revenue_sum", 0)),
        delivery_ms_sum=int(doc.get("delivery_ms_sum", 0)),
        delivery_ms_count=int(doc.get("delivery_ms_count", 0)),
        updated_at=doc.get("updated_at") or datetime.fromtimestamp(0, UTC),
    )


class AggRestaurantDayRepo:
    def __init__(self, db: Database) -> None:
        self._col = db[AGG_RESTAURANT_DAY]

    async def add_placed_order(
        self, *, restaurant_id: int, day: str, currency: str, total_minor: int
    ) -> None:
        """One more order on this restaurant-day. Creates the day on first use.

        ``$inc`` is applied by the server, atomically, so two consumers
        incrementing the same day concurrently both count. Read-modify-write
        in Python (find, add, save) would lose one of them.

        ``$setOnInsert`` fills the fields a brand-new day needs and is ignored
        on every later update — currency included: a restaurant trades in its
        branch country's currency, so the first order of the day fixes it.
        ``$set`` would let a stray event flip it.

        Upsert races: if two upserts both find no document, the unique index
        lets one insert win and the server retries the other as an update
        (MongoDB ≥ 4.2 does this for equality filters on a unique index).
        """
        await self._col.update_one(
            {"restaurant_id": restaurant_id, "date": day},
            {
                "$inc": {"orders_count": 1, "revenue_sum": total_minor},
                "$setOnInsert": {"currency": currency, "delivery_ms_sum": 0, "delivery_ms_count": 0},
                "$set": {"updated_at": datetime.now(UTC)},
            },
            upsert=True,
        )

    async def find_range(self, restaurant_id: int, start: str, end: str) -> list[AggRestaurantDay]:
        """Days in ``[start, end]`` (inclusive), oldest first.

        Served entirely by ``uq_agg_restaurant_day_restaurant_id_date``:
        equality on the first key, range on the second, sort on the second.
        """
        cursor = self._col.find(
            {"restaurant_id": restaurant_id, "date": {"$gte": start, "$lte": end}},
            _PROJECTION,
        ).sort("date", 1)
        return [_to_entity(doc) async for doc in cursor]
