from enum import StrEnum

#: The one permission this module checks. Seeded in core's catalog onto the
#: restaurant roles that may read analytics (see docs/api-contracts.md §Auth).
PERM_ANALYTICS_READ = "analytics:read"


class OrderEventType(StrEnum):
    """Routing keys from order-service's ``lib/events/event-types.ts`` that
    this module handles. The rest of ``order.#`` / ``payment.#`` is acked and
    skipped by the consumer."""

    ORDER_PLACED = "order.placed"
