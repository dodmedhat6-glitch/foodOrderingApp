"""RabbitMQ client on aio-pika — order-service's `pkg/messaging/rabbitmq.client.ts`.

App-agnostic: no queue or exchange names live here; they arrive in `ConsumerOptions`.

`connect_robust` is the Python `amqp-connection-manager`: after a drop it
reconnects and restores channels, queues, bindings and consumers. Unlike the Node
library it is only robust after the *first* connect succeeds — a broker that is
down at boot makes `connect()` raise, and the caller retries.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractQueue, AbstractRobustConnection

MessageHandler = Callable[[AbstractIncomingMessage], Awaitable[None]]

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConsumerOptions:
    exchange: str
    queue: str
    binding_keys: list[str]
    prefetch: int
    dead_letter_exchange: str
    dead_letter_queue: str


class AmqpBroker:
    def __init__(self, url: str, on_state_change: Callable[[str, str | None], None] | None = None) -> None:
        self._url = url
        self._notify = on_state_change  # a callback, because pkg/ can't import the app's logger
        self._connection: AbstractRobustConnection | None = None
        self._consumers: list[tuple[AbstractQueue, str]] = []
        self._closing = False

    async def connect(self) -> None:
        if self._connection is not None:
            return
        self._connection = await aio_pika.connect_robust(self._url, timeout=5)
        if self._notify is not None:
            notify = self._notify
            # close_callbacks also fire on our own close(), hence the flag.
            self._connection.close_callbacks.add(
                lambda _c, exc=None: None if self._closing else notify("disconnected", str(exc))
            )
            self._connection.reconnect_callbacks.add(lambda _c: notify("connected", None))
            notify("connected", None)

    def is_connected(self) -> bool:
        return self._connection is not None and not self._connection.is_closed

    async def consume(self, opts: ConsumerOptions, handler: MessageHandler) -> None:
        """Assert topology (idempotent) and start delivering, manual ack.

        Topology is declared on the consumer's own channel so the robust channel
        replays it on reconnect. Settings that disagree with an existing queue
        make the broker refuse with PRECONDITION_FAILED — delete the queue.
        """
        await self.connect()
        assert self._connection is not None
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=opts.prefetch)

        exchange = await channel.declare_exchange(opts.exchange, aio_pika.ExchangeType.TOPIC, durable=True)
        dlx = await channel.declare_exchange(
            opts.dead_letter_exchange, aio_pika.ExchangeType.TOPIC, durable=True
        )
        dlq = await channel.declare_queue(opts.dead_letter_queue, durable=True)
        await dlq.bind(dlx, routing_key="#")  # keeps the original routing key
        queue = await channel.declare_queue(
            opts.queue, durable=True, arguments={"x-dead-letter-exchange": opts.dead_letter_exchange}
        )
        for key in opts.binding_keys:
            await queue.bind(exchange, routing_key=key)

        async def on_message(message: AbstractIncomingMessage) -> None:
            try:
                await handler(message)
            except Exception:
                # The handler should ack/nack itself; if it raised, dead-letter rather
                # than requeue a poison message into a tight redelivery loop.
                _log.exception("amqp handler raised; message dead-lettered")
                if not message.processed:
                    await message.nack(requeue=False)

        self._consumers.append((queue, await queue.consume(on_message)))

    async def stop_consuming(self) -> None:
        """Stop deliveries; prefetched-but-unstarted messages go back to the queue."""
        for queue, tag in self._consumers:
            await queue.cancel(tag)
        self._consumers.clear()

    async def publish(self, exchange: str, routing_key: str, body: bytes) -> None:
        """Persistent publish, resolved on the broker's confirm (used by play/; the service emits nothing)."""
        await self.connect()
        assert self._connection is not None
        async with self._connection.channel(publisher_confirms=True) as channel:
            target = await channel.declare_exchange(exchange, aio_pika.ExchangeType.TOPIC, durable=True)
            message = aio_pika.Message(body, content_type="application/json", delivery_mode=2)
            await target.publish(message, routing_key=routing_key)

    async def close(self) -> None:
        self._closing = True
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception as exc:
                _log.warning("amqp close failed: %s", exc)
        self._connection = None
        self._consumers.clear()
        self._closing = False
