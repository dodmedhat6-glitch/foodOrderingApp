"""Transport for inbound events, and nothing else: topology, dedupe, dispatch, ack/nack.

A Python port of order-service's ``lib/core-events/consumer.ts``. What an
event *means* lives in ``app/<module>/eventhandlers``; what it *does* lives in
the service those call. (The package keeps the ``coreevents`` name from its
Node twin; the stream it consumes here is order-service's.)

Per message::

    parse envelope ── bad JSON / no eventId ──────────────► nack → DLQ
    routing key ≠ eventType ──────────────────────────────► nack → DLQ
    find handler ──── unknown eventType ──────────────────► log, ack (skip)
    mark_seen ─────── already seen ───────────────────────► ack (skip)
    handler ───────── raises ──► forget(eventId) ─────────► nack → DLQ
                      returns ────────────────────────────► ack

Two deliberate differences from the Node consumer:

- **Handler lookup before dedupe.** This queue is bound to ``payment.#`` too,
  and most of those have no handler yet. Recording their ids would be a
  Mongo write per message for nothing.
- **A failed handler un-marks its event.** Node's Redis dedupe marks first
  and never un-marks, so a message replayed from the DLQ after a fix would be
  skipped as a duplicate. ``forget`` makes a DLQ replay actually re-apply.
"""

import asyncio
from typing import Protocol

from pydantic import ValidationError

from lib.appcontext.context import reset_correlation_id, set_correlation_id
from lib.coreevents.payloads import Envelope, EventHandler, EventMeta
from lib.logger.logger import Logger
from pkg.messaging.types import Broker, ConsumeMessage, ConsumerOptions


class EventDeduper(Protocol):
    """ "Have I processed this event before?" — and the ability to take it back.

    ``lib`` may not import ``app``, so the consumer declares the capability it
    needs and the Mongo-backed ``EventIDsRepo`` in ``app/analytics/repository``
    satisfies it structurally — it never imports or subclasses this Protocol.
    """

    async def mark_seen(self, event_id: str) -> bool:
        """Record the id. True if it was new, False if it was already there."""
        ...

    async def forget(self, event_id: str) -> None: ...


class EventConsumer:
    def __init__(
        self,
        broker: Broker,
        options: ConsumerOptions,
        deduper: EventDeduper,
        handlers: dict[str, EventHandler],
        logger: Logger,
    ) -> None:
        self._broker = broker
        self._options = options
        self._deduper = deduper
        self._handlers = dict(handlers)
        self._logger = logger
        # Messages currently inside handle(). stop() waits for this to drain
        # so shutdown never closes Mongo under a half-applied event.
        self._in_flight = 0
        self._idle = asyncio.Event()
        self._idle.set()

    async def start(self) -> None:
        await self._broker.declare_topology(self._options)
        await self._broker.consume(self._options, self.handle)
        self._logger.info(
            "event consumer started",
            queue=self._options.queue,
            bindings=list(self._options.binding_keys),
            handlers=sorted(self._handlers),
        )

    async def stop(self, timeout_sec: float = 10.0) -> None:
        """Stop deliveries, then wait (bounded) for in-flight messages to finish.

        Anything still running at the deadline is left unacked; the broker
        redelivers it to the next consumer when our connection closes.
        """
        await self._broker.stop_consuming()
        try:
            await asyncio.wait_for(self._idle.wait(), timeout_sec)
        except TimeoutError:
            self._logger.warn("event consumer stop timed out", inFlight=self._in_flight)
        self._logger.info("event consumer stopped")

    async def handle(self, msg: ConsumeMessage) -> None:
        """Public so ``play/`` and tests can drive one message without a broker."""
        self._in_flight += 1
        self._idle.clear()
        try:
            await self._handle(msg)
        finally:
            self._in_flight -= 1
            if self._in_flight == 0:
                self._idle.set()

    async def _handle(self, msg: ConsumeMessage) -> None:
        try:
            envelope = Envelope.model_validate_json(msg.body)
        except ValidationError:
            self._logger.warn("event envelope unparseable, dead-lettering", routingKey=msg.routing_key)
            await msg.nack(False)
            return

        # The publisher routes on the event type (order-service's drain passes
        # eventType as the routing key). A body that claims to be something
        # other than what it was routed as is a publisher bug or a forgery;
        # trusting the body would let a `payment.*` message move order counts.
        if msg.routing_key and msg.routing_key != envelope.event_type:
            self._logger.warn(
                "event type does not match routing key, dead-lettering",
                routingKey=msg.routing_key,
                eventType=envelope.event_type,
                eventId=envelope.event_id,
            )
            await msg.nack(False)
            return

        meta = EventMeta(
            event_id=envelope.event_id,
            event_type=envelope.event_type,
            occurred_at=envelope.occurred_at,
            correlation_id=envelope.correlation_id or envelope.event_id,
        )
        # Everything logged while handling this message — here, in the service,
        # in the repository — carries this delivery's correlation id.
        token = set_correlation_id(meta.correlation_id)
        log = self._logger.bind(
            correlationId=meta.correlation_id, eventId=meta.event_id, eventType=meta.event_type
        )
        try:
            handler = self._handlers.get(envelope.event_type)
            if handler is None:
                log.info("no handler for event type, acking")
                await msg.ack()
                return

            if not await self._deduper.mark_seen(envelope.event_id):
                log.info("duplicate event, acking")
                await msg.ack()
                return

            try:
                await handler(envelope.payload, meta)
            except Exception as exc:
                log.error("event handler failed, dead-lettering", exc_info=True, error=str(exc))
                await self._deduper.forget(envelope.event_id)
                await msg.nack(False)
                return

            await msg.ack()
            log.info("event processed")
        finally:
            reset_correlation_id(token)
