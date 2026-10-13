"""Every index this module needs, created idempotently at boot.

Mongo has no migrations; this file is where the schema decisions live instead.
``create_index`` with the same keys and options is a no-op, so running it on
every boot is safe — the Python analogue of ``knex migrate:latest`` for
indexes only.

Same rules as the SQL migrations in the Node services:

- Every index names the query it supports. No speculative indexes.
- Equality fields first, then the range field.
- Explicit names (``uq_…``, ``idx_…``, ``ttl_…``) so an index is greppable.

Changing the options of an existing index (say, the TTL) is *not* a no-op:
the server refuses with ``IndexOptionsConflict``. Change a TTL with
``collMod``; change keys by dropping the old index first. That is the closest
Mongo comes to needing a migration.
"""

from pymongo import ASCENDING, IndexModel

from app.analytics.repository.collections import AGG_RESTAURANT_DAY, EVENT_IDS
from pkg.mongo.types import Database


async def ensure_indexes(db: Database, *, event_ids_ttl_sec: int) -> None:
    await db[AGG_RESTAURANT_DAY].create_indexes(
        [
            # The identity of a rollup row and the target of every upsert —
            # unique, so two consumers racing on a new day cannot create two
            # documents for it. Also serves
            # GET /restaurants/{id}/days?from=&to= (equality on restaurant_id,
            # range on date: exactly the equality-then-range shape).
            IndexModel(
                [("restaurant_id", ASCENDING), ("date", ASCENDING)],
                name="uq_agg_restaurant_day_restaurant_id_date",
                unique=True,
            ),
            # Date-first: "every restaurant on these days" — the cross-
            # restaurant reads (active-restaurants, platform backfill checks)
            # that the unique index above cannot serve without a full scan.
            IndexModel(
                [("date", ASCENDING), ("restaurant_id", ASCENDING)],
                name="idx_agg_restaurant_day_date_restaurant_id",
            ),
        ]
    )

    await db[EVENT_IDS].create_indexes(
        [
            # The dedupe gate: insert_one raises DuplicateKeyError on a replay.
            IndexModel([("event_id", ASCENDING)], name="uq_event_ids_event_id", unique=True),
            # Mongo's TTL monitor deletes a document once received_at is older
            # than this. Runs every ~60s, so expiry is approximate — fine for a
            # window measured in days.
            IndexModel(
                [("received_at", ASCENDING)],
                name="ttl_event_ids_received_at",
                expireAfterSeconds=event_ids_ttl_sec,
            ),
        ]
    )
