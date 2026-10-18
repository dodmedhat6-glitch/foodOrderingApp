"""The only place pymongo is used. Plain driver, no ODM: projections, explicit mappers,
server-side update operators. Indexes are declared here and created at boot."""

from datetime import UTC, datetime
from typing import Any

from pymongo import ASCENDING, IndexModel
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from app.analytics.types import AggRestaurantDay

Database = AsyncDatabase[dict[str, Any]]

AGG_RESTAURANT_DAY = "agg_restaurant_day"
EVENT_IDS = "event_ids"


async def ensure_indexes(db: Database, event_ids_ttl_sec: int) -> None:
    """Idempotent: same spec = no-op. Changing an existing index's options (e.g. the TTL)
    raises IndexOptionsConflict — use `collMod` for that."""
    await db[AGG_RESTAURANT_DAY].create_indexes(
        [
            # Identity of a rollup row (makes concurrent first-upserts safe) and serves
            # GET /restaurants/{id}/days: equality on restaurant_id, range on date.
            IndexModel(
                [("restaurant_id", ASCENDING), ("date", ASCENDING)],
                name="uq_agg_restaurant_day_restaurant_id_date",
                unique=True,
            ),
            # Cross-restaurant reads by day (active-restaurants, backfill checks).
            IndexModel(
                [("date", ASCENDING), ("restaurant_id", ASCENDING)],
                name="idx_agg_restaurant_day_date_restaurant_id",
            ),
        ]
    )
    await db[EVENT_IDS].create_indexes(
        [
            IndexModel(
                [("event_id", ASCENDING)], name="uq_event_ids_event_id", unique=True
            ),  # the dedupe gate
            IndexModel(
                [("received_at", ASCENDING)],
                name="ttl_event_ids_received_at",
                expireAfterSeconds=event_ids_ttl_sec,
            ),
        ]
    )


class AggRestaurantDayRepo:
    def __init__(self, db: Database) -> None:
        self._col = db[AGG_RESTAURANT_DAY]

    async def add_placed_order(self, restaurant_id: int, day: str, currency: str, total_minor: int) -> None:
        """One atomic upsert. `$inc` runs on the server, so concurrent consumers both count
        (read-modify-write in Python would lose one). `$setOnInsert` initializes a new day —
        the first event fixes its currency."""
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
        """Days in [start, end], oldest first — served by uq_agg_restaurant_day_restaurant_id_date."""
        cursor = self._col.find(
            {"restaurant_id": restaurant_id, "date": {"$gte": start, "$lte": end}},
            {"_id": 0, "restaurant_id": 1, "date": 1, "currency": 1, "orders_count": 1, "revenue_sum": 1},
        ).sort("date", ASCENDING)
        return [
            AggRestaurantDay(
                restaurant_id=int(doc["restaurant_id"]),
                date=str(doc["date"]),
                currency=str(doc.get("currency", "")),
                orders_count=int(doc.get("orders_count", 0)),
                revenue_sum=int(doc.get("revenue_sum", 0)),
            )
            async for doc in cursor
        ]


class EventIdsRepo:
    """Dedupe ledger. Satisfies `lib.events.EventDeduper` structurally."""

    def __init__(self, db: Database) -> None:
        self._col = db[EVENT_IDS]

    async def mark_seen(self, event_id: str) -> bool:
        """Insert-and-catch, not find-then-insert: the unique index decides atomically who was first."""
        try:
            await self._col.insert_one({"event_id": event_id, "received_at": datetime.now(UTC)})
        except DuplicateKeyError:
            return False
        return True

    async def forget(self, event_id: str) -> None:
        await self._col.delete_one({"event_id": event_id})
