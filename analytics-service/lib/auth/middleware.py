"""``authenticate`` — the guard.ts of this service, as a FastAPI dependency.

Express middleware is a function ``(req, res, next)`` placed in front of the
handler. FastAPI's equivalent is a *dependency*: a callable FastAPI runs
before the endpoint, whose return value it can inject and whose exception
short-circuits the request. A class instance with ``__call__`` works as one,
which is how the secret gets in without a global: ``lib/boot`` constructs
``Authenticate(env.jwt.access_secret)`` once and routes ``Depends`` on it.
"""

from fastapi import Request

from lib.appcontext.context import Claims, set_claims
from lib.auth.errors import ERR_UNAUTHENTICATED
from lib.auth.jwt import verify_access_token

COOKIE = "access_token"
_BEARER = "Bearer "


class Authenticate:
    def __init__(self, access_secret: str) -> None:
        self._secret = access_secret

    async def __call__(self, request: Request) -> Claims:
        """Cookie first (the web client), then ``Authorization: Bearer``
        (tooling, other services) — the same precedence as order-service."""
        token = request.cookies.get(COOKIE)
        if not token:
            header = request.headers.get("authorization", "")
            token = header[len(_BEARER) :] if header.startswith(_BEARER) else None
        if not token:
            raise ERR_UNAUTHENTICATED

        claims = verify_access_token(token, self._secret)
        set_claims(claims)
        return claims
