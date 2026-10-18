"""Inbound event consumer — order-service's `lib/core-events/consumer.ts`.

Transport only: parse, route, dedupe, dispatch, ack/nack. What an event *does* is
in the handler `app/` registers; this module never imports `app/`.

    bad envelope / routing key != eventType ──► nack → DLQ
    no handler for eventType ─────────────────► ack (skip)
    eventId already seen ─────────────────────► ack (skip)
    handler raises ──► forget(eventId) ───────► nack → DLQ   (so a DLQ replay re-applies)
    handler returns ──────────────────────────► ack
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from aio_pika.abc import AbstractIncomingMessage
from pydantic import BaseModel, Field, ValidationError

from lib.logger import correlation_id, logger
from pkg.messaging import AmqpBroker, ConsumerOptions

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


class EventDeduper(Protocol):
    """Implemented by `app/analytics/repository.EventIdsRepo` — structurally, without importing this.
    That is how `lib/` depends on a capability whose Mongo code lives in `app/`."""

    async def mark_seen(self, event_id: str) -> bool: ...  # True if new
    async def forget(self, event_id: str) -> None: ...


class _Envelope(BaseModel):
    """The platform envelope (order-service `lib/events/types.ts` OutboundEventEnvelope)."""

    eventId: str = Field(min_length=1)
    eventType: str = Field(min_length=1)
    correlationId: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class EventConsumer:
    def __init__(
        self,
        broker: AmqpBroker,
        options: ConsumerOptions,
        deduper: EventDeduper,
        handlers: dict[str, EventHandler],
    ) -> None:
        self._broker, self._options, self._deduper, self._handlers = broker, options, deduper, handlers
        self._in_flight = 0
        self._idle = asyncio.Event()
        self._idle.set()

    async def start(self) -> None:
        await self._broker.consume(self._options, self.handle)
        logger.info(
            "event consumer started",
            queue=self._options.queue,
            bindings=self._options.binding_keys,
            handlers=sorted(self._handlers),
        )

    async def stop(self, timeout_sec: float = 10) -> None:
        """Stop deliveries, then wait (bounded) for in-flight messages so Mongo isn't closed under one."""
        await self._broker.stop_consuming()
        try:
            await asyncio.wait_for(self._idle.wait(), timeout_sec)
        except TimeoutError:
            logger.warn("event consumer stop timed out", inFlight=self._in_flight)
        logger.info("event consumer stopped")

    async def handle(self, msg: AbstractIncomingMessage) -> None:
        self._in_flight += 1
        self._idle.clear()
        try:
            await self._handle(msg)
        finally:
            self._in_flight -= 1
            if self._in_flight == 0:
                self._idle.set()

    async def _handle(self, msg: AbstractIncomingMessage) -> None:
        try:
            env = _Envelope.model_validate_json(msg.body)
        except ValidationError:
            logger.warn("event envelope unparseable, dead-lettering", routingKey=msg.routing_key)
            await msg.nack(requeue=False)
            return
        # The publisher routes on the event type. A body claiming to be something else is a
        # publisher bug or a forgery; trusting it would let a `payment.*` message move order counts.
        if msg.routing_key != env.eventType:
            logger.warn(
                "event type does not match routing key, dead-lettering",
                routingKey=msg.routing_key,
                eventType=env.eventType,
                eventId=env.eventId,
            )
            await msg.nack(requeue=False)
            return

        token = correlation_id.set(env.correlationId or env.eventId)
        try:
            handler = self._handlers.get(env.eventType)
            if handler is None:
                logger.info("no handler for event type, acking", eventType=env.eventType, eventId=env.eventId)
                await msg.ack()
                return
            if not await self._deduper.mark_seen(env.eventId):
                logger.info("duplicate event, acking", eventType=env.eventType, eventId=env.eventId)
                await msg.ack()
                return
            try:
                await handler(env.payload)
            except Exception as exc:
                logger.error(
                    "event handler failed, dead-lettering",
                    exc_info=True,
                    eventType=env.eventType,
                    eventId=env.eventId,
                    error=str(exc),
                )
                await self._deduper.forget(env.eventId)
                await msg.nack(requeue=False)
                return
            await msg.ack()
            logger.info("event processed", eventType=env.eventType, eventId=env.eventId)
        finally:
            correlation_id.reset(token)
