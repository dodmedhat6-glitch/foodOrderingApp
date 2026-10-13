"""aio-pika implementation of the ``Broker`` Protocol.

Mental model (same as order-service's ``rabbitmq.client.ts``):

- 1 TCP connection -> many cheap virtual channels. One channel per purpose:
  one for publishing, one per consumer.
- ``connect_robust`` is the Python counterpart of ``amqp-connection-manager``.
  After a drop it reconnects and *restores* every channel, exchange, queue,
  binding and consumer declared through it, so topology and the consumer come
  back on their own after a broker restart.

One difference to know about: aio-pika's robust connection only becomes
robust once it has connected *once*. A broker that is down at boot makes
``connect()`` raise (after ``connect_timeout_sec``) instead of retrying
forever like the Node library. ``lib/boot`` owns what happens then.
"""

import logging
from typing import Any

import aio_pika
from aio_pika.abc import (
    AbstractChannel,
    AbstractIncomingMessage,
    AbstractQueue,
    AbstractRobustConnection,
)

from pkg.messaging.types import AmqpConfig, ConsumeMessage, ConsumerOptions, MessageHandler

_log = logging.getLogger(__name__)


class AmqpBroker:
    def __init__(self, config: AmqpConfig) -> None:
        self._config = config
        self._connection: AbstractRobustConnection | None = None
        self._publish_channel: AbstractChannel | None = None
        self._consumers: list[tuple[AbstractQueue, str]] = []
        self._closing = False

    async def connect(self) -> None:
        """Open the connection and the long-lived publisher channel. Idempotent."""
        if self._connection is not None:
            return

        connection = await aio_pika.connect_robust(
            self._config.url,
            timeout=self._config.connect_timeout_sec,
            reconnect_interval=self._config.reconnect_interval_sec,
        )

        notify = self._config.on_state_change
        if notify is not None:
            # close_callbacks also fire on our own close() — with a
            # CancelledError, not None — so a deliberate close is filtered by
            # flag, not by the exception.
            def on_close(_conn: object, exc: BaseException | None = None) -> None:
                if not self._closing:
                    notify("disconnected", _describe(exc))

            connection.close_callbacks.add(on_close)
            connection.reconnect_callbacks.add(lambda _conn: notify("connected", None))

        self._connection = connection
        # publisher_confirms=True: publish() awaits the broker's ack, so a
        # returned call means the broker has the message.
        self._publish_channel = await connection.channel(publisher_confirms=True)
        if notify is not None:
            notify("connected", None)

    async def close(self) -> None:
        """Close channels then the connection. Already-closed is fine."""
        self._closing = True
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception:
                pass
        self._connection = None
        self._publish_channel = None
        self._consumers = []
        self._closing = False

    async def declare_topology(self, opts: ConsumerOptions) -> None:
        """Assert exchange, DLX/DLQ, queue and bindings on a throwaway channel."""
        connection = await self._require_connection()
        channel = await connection.channel()
        try:
            await _assert_topology(channel, opts)
        finally:
            await channel.close()

    async def consume(self, opts: ConsumerOptions, handler: MessageHandler) -> None:
        """Open a long-lived consumer channel and start delivering to ``handler``.

        Topology is asserted on this same channel so that the robust channel
        records it and replays it on reconnect.
        """
        connection = await self._require_connection()
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=opts.prefetch)  # max unacked in flight
        queue = await _assert_topology(channel, opts)

        async def on_message(raw: AbstractIncomingMessage) -> None:
            async def nack(requeue: bool) -> None:
                await raw.nack(requeue=requeue)

            msg = ConsumeMessage(routing_key=raw.routing_key or "", body=raw.body, ack=raw.ack, nack=nack)
            try:
                await handler(msg)
            except Exception:
                # The handler is expected to ack/nack itself; an exception that
                # escapes it is a bug there, and the safe outcome is the DLQ —
                # never a requeue, which would redeliver the same poison message
                # in a tight loop. Logged through stdlib logging, which the app
                # configures; pkg/ cannot import the app's logger.
                _log.exception("amqp handler raised; message dead-lettered")
                if not raw.processed:
                    await raw.nack(requeue=False)

        tag = await queue.consume(on_message, no_ack=False)  # manual ack
        self._consumers.append((queue, tag))

    async def stop_consuming(self) -> None:
        """Cancel every consumer: the broker stops pushing, and anything it had
        prefetched to us but we had not started is returned to the queue."""
        consumers, self._consumers = self._consumers, []
        for queue, tag in consumers:
            try:
                await queue.cancel(tag)
            except Exception:
                pass

    def is_connected(self) -> bool:
        return self._connection is not None and not self._connection.is_closed

    async def publish(self, exchange: str, routing_key: str, body: bytes) -> None:
        """Persistent publish, resolved on the broker's confirm."""
        await self._require_connection()
        assert self._publish_channel is not None
        target = await self._publish_channel.declare_exchange(
            exchange, aio_pika.ExchangeType.TOPIC, durable=True
        )
        await target.publish(
            aio_pika.Message(
                body,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=routing_key,
        )

    async def _require_connection(self) -> AbstractRobustConnection:
        await self.connect()
        assert self._connection is not None
        return self._connection


# ---------- helpers ----------


async def _assert_topology(channel: AbstractChannel, opts: ConsumerOptions) -> AbstractQueue:
    """ "Assert" = create if missing, else verify the settings match. Idempotent.

    Settings that disagree with an existing queue (say, adding a DLX to a
    queue that was first declared without one) make the broker close the
    channel with PRECONDITION_FAILED. That is a deploy problem, not a code
    path: delete the queue, or migrate it with a policy.
    """
    exchange = await channel.declare_exchange(opts.exchange, aio_pika.ExchangeType.TOPIC, durable=True)

    arguments: dict[str, Any] = {}
    if opts.dead_letter_exchange and opts.dead_letter_queue:
        dlx = await channel.declare_exchange(
            opts.dead_letter_exchange, aio_pika.ExchangeType.TOPIC, durable=True
        )
        dlq = await channel.declare_queue(opts.dead_letter_queue, durable=True)
        await dlq.bind(dlx, routing_key="#")  # catch-all: keep the original routing key
        arguments["x-dead-letter-exchange"] = opts.dead_letter_exchange

    queue = await channel.declare_queue(opts.queue, durable=True, arguments=arguments)
    for key in opts.binding_keys:
        await queue.bind(exchange, routing_key=key)
    return queue


def _describe(exc: BaseException | None) -> str | None:
    if exc is None:
        return None
    return str(exc) or type(exc).__name__
