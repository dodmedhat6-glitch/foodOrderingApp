"""``event_ids`` — the consumer's dedupe ledger.

Satisfies ``lib.coreevents.consumer.EventDeduper`` without importing it:
Python Protocols are structural, so having ``mark_seen`` and ``forget`` with
the right signatures is the whole of "implementing" it. That is what lets
``lib/`` depend on a capability while the Mongo code stays in ``app/``.
"""

from datetime import UTC, datetime

from pymongo.errors import DuplicateKeyError

from app.analytics.repository.collections import EVENT_IDS
from pkg.mongo.types import Database


class EventIDsRepo:
    def __init__(self, db: Database) -> None:
        self._col = db[EVENT_IDS]

    async def mark_seen(self, event_id: str) -> bool:
        """Insert the id; the unique index turns a replay into DuplicateKeyError.

        Insert-and-catch, not find-then-insert: two deliveries of one event
        racing through find-then-insert can both see "absent". The unique
        index decides atomically which one was first.
        """
        try:
            await self._col.insert_one({"event_id": event_id, "received_at": datetime.now(UTC)})
        except DuplicateKeyError:
            return False
        return True

    async def forget(self, event_id: str) -> None:
        """Undo ``mark_seen`` for an event whose handler failed, so a replay
        from the DLQ is applied instead of skipped as a duplicate."""
        await self._col.delete_one({"event_id": event_id})
