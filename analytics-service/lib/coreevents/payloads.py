"""The inbound event envelope and the handler signature.

The envelope is what order-service's outbox drain publishes (its
``lib/events/types.ts`` ``OutboundEventEnvelope``), which is in turn the shape
core's drain publishes — one envelope across the platform::

    {"eventId": "...", "eventType": "order.placed", "occurredAt": "...Z",
     "entityType": "order", "entityId": "...", "payload": {...}}

Only ``eventId`` and ``eventType`` are required to *route* a message. What the
payload means is the handler's business; here it is an opaque mapping.
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Envelope(BaseModel):
    # Wire names are camelCase; populate_by_name lets tests build one with
    # snake_case kwargs too.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    event_id: str = Field(alias="eventId", min_length=1)
    event_type: str = Field(alias="eventType", min_length=1)
    occurred_at: str | None = Field(default=None, alias="occurredAt")
    entity_type: str | None = Field(default=None, alias="entityType")
    entity_id: str | None = Field(default=None, alias="entityId")
    correlation_id: str | None = Field(default=None, alias="correlationId")
    payload: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class EventMeta:
    """Envelope metadata handed to a handler next to the payload.

    ``correlation_id`` falls back to the event id, so a log line a handler
    writes is always attributable to one specific delivery.
    """

    event_id: str
    event_type: str
    occurred_at: str | None
    correlation_id: str


#: ``(payload, meta) -> None``. Raise to dead-letter the message.
EventHandler = Callable[[Mapping[str, Any], EventMeta], Awaitable[None]]
