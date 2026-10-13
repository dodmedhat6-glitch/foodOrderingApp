"""Per-request (and per-message) context — the Python stand-in for ``express.d.ts``.

Express hangs ``req.user`` and ``req.correlationId`` off the request object
and every middleware passes ``req`` along. Python's asyncio has a better tool
for "value scoped to this unit of work": ``contextvars``. Each request runs in
its own task with its own copy of the context, so a value set by the
correlation middleware is visible to every ``await`` below it — the service,
the repository, the core client — without being threaded through every
signature, and is invisible to every other request running concurrently.

Two rules keep this from turning into hidden global state:

- Only middleware (and the event consumer, for messages) *sets* these.
- Code that needs a value reads it here; it never stores it on ``self``.
"""

from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass(frozen=True)
class Claims:
    """The verified access token, in this service's own shape.

    Core signs ``user_id`` (snake_case) next to ``restaurantId`` (camelCase);
    ``lib/auth/jwt.py`` decodes that wire format and hands everything else
    this one. Same move as order-service's ``toPayload``.
    """

    user_id: int
    role: str
    email: str
    restaurant_id: int | None = None
    restaurant_role: str | None = None
    branch_ids: tuple[int, ...] = ()


_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)
_claims: ContextVar[Claims | None] = ContextVar("claims", default=None)


def correlation_id() -> str | None:
    return _correlation_id.get()


def set_correlation_id(value: str) -> Token[str | None]:
    return _correlation_id.set(value)


def reset_correlation_id(token: Token[str | None]) -> None:
    _correlation_id.reset(token)


def claims() -> Claims | None:
    return _claims.get()


def set_claims(value: Claims) -> Token[Claims | None]:
    return _claims.set(value)
