"""The broker contract, independent of any AMQP library.

Mirrors order-service's ``pkg/messaging/message-broker.interface.ts``. The
``Broker`` Protocol is what ``lib/`` depends on; ``amqp.py`` is one
implementation of it. Nothing here names a queue or an exchange this service
uses — those arrive as ``ConsumerOptions`` built from env in ``lib/boot``.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

ConnectionState = Literal["connected", "disconnected"]

#: Called on every connect, reconnect and disconnect. A callback rather than a
#: logger because ``pkg/`` must not import the app's logger (it lives in
#: ``lib/``); ``lib/boot`` passes one that logs.
StateListener = Callable[[ConnectionState, str | None], None]


@dataclass(frozen=True)
class AmqpConfig:
    url: str
    #: Seconds between reconnect attempts after an established connection drops.
    reconnect_interval_sec: float = 5.0
    #: Bound on the *first* connect. A broker that is down at boot fails this
    #: call instead of hanging it; ``lib/boot`` then retries in the background.
    connect_timeout_sec: float = 5.0
    on_state_change: StateListener | None = None


@dataclass(frozen=True)
class ConsumerOptions:
    exchange: str
    queue: str
    binding_keys: tuple[str, ...]
    prefetch: int
    dead_letter_exchange: str | None = None
    dead_letter_queue: str | None = None


@dataclass(frozen=True)
class ConsumeMessage:
    """One delivery, in a shape that does not leak the AMQP library.

    ``ack``/``nack`` are closures over the library's message object — the
    same trick as the Node version's ``{ack: () => ch.ack(raw)}``.
    ``nack(requeue=False)`` routes the message to the queue's dead-letter
    exchange when one is configured.
    """

    routing_key: str
    body: bytes
    ack: Callable[[], Awaitable[None]]
    nack: Callable[[bool], Awaitable[None]]


MessageHandler = Callable[[ConsumeMessage], Awaitable[None]]


class Broker(Protocol):
    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    async def declare_topology(self, opts: ConsumerOptions) -> None: ...

    async def consume(self, opts: ConsumerOptions, handler: MessageHandler) -> None: ...

    async def stop_consuming(self) -> None:
        """Stop new deliveries; messages already being handled are unaffected."""
        ...

    def is_connected(self) -> bool: ...

    async def publish(self, exchange: str, routing_key: str, body: bytes) -> None: ...
