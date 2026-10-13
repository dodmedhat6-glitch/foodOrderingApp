"""JWT auth + RBAC as FastAPI dependencies — order-service's `guard.ts` + `rbac.ts`.

A FastAPI dependency is per-route middleware: it runs before the handler, raises to
stop the request, and can return a value (the claims). `Auth` is built once in
`server.py` with the secret and the permissions cache, then used on routes as
`Depends(auth.require("analytics:read"))`.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Path, Request
from pydantic import BaseModel, Field, ValidationError

from lib.errors import AppError

ERR_UNAUTHENTICATED = AppError("UNAUTHENTICATED", 401, "User not authenticated")
ERR_PERMISSION_DENIED = AppError("PERMISSION_DENIED", 403, "Permission denied")

SYSTEM_ADMIN = "system_admin"
RESTAURANT_USER = "restaurant_user"


@dataclass(frozen=True)
class Claims:
    user_id: int
    role: str
    restaurant_id: int | None
    restaurant_role: str | None


class _TokenClaims(BaseModel):
    """Core's claim set exactly as signed (core-service `app/auth/utils.ts`): `user_id` is snake_case."""

    user_id: int = Field(gt=0)
    role: str = Field(min_length=1)
    restaurantId: int | None = None
    restaurantRole: str | None = None


class PermissionsCache:
    """role -> permissions, read through from core, kept in process for `ttl_sec`.

    Single-flight: when a role is cold, concurrent requests wait for one core call
    instead of each making their own. `invalidate` is the hook for the
    `rbac.permissions_changed` consumer (homework).
    """

    def __init__(self, load: Callable[[str], Awaitable[frozenset[str]]], ttl_sec: float) -> None:
        self._load, self._ttl = load, ttl_sec
        self._entries: dict[str, tuple[float, frozenset[str]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, role: str) -> frozenset[str]:
        entry = self._entries.get(role)
        if entry is not None and entry[0] > time.monotonic():  # hit: no lock, no await
            return entry[1]
        async with self._locks.setdefault(role, asyncio.Lock()):
            entry = self._entries.get(role)
            if entry is None or entry[0] <= time.monotonic():
                entry = (time.monotonic() + self._ttl, await self._load(role))
                self._entries[role] = entry
            return entry[1]

    def invalidate(self, role: str | None = None) -> None:
        if role is None:
            self._entries.clear()
        else:
            self._entries.pop(role, None)


class Auth:
    def __init__(self, access_secret: str, permissions: PermissionsCache) -> None:
        self._secret = access_secret
        self._permissions = permissions

    async def authenticate(self, request: Request) -> Claims:
        """Cookie `access_token` first, then `Authorization: Bearer`. Every failure is the same 401."""
        header = request.headers.get("authorization", "")
        token = request.cookies.get("access_token") or (header[7:] if header.startswith("Bearer ") else None)
        if not token:
            raise ERR_UNAUTHENTICATED
        try:
            # algorithms pinned: never trust the token's own `alg` header.
            raw = _TokenClaims.model_validate(jwt.decode(token, self._secret, algorithms=["HS256"]))
        except (jwt.PyJWTError, ValidationError) as exc:
            raise ERR_UNAUTHENTICATED from exc
        return Claims(raw.user_id, raw.role, raw.restaurantId, raw.restaurantRole)

    def require_restaurant_member(self) -> Callable[..., Awaitable[None]]:
        """The path's `restaurantId` must be the caller's. A malformed id is a 400 from validation."""

        async def guard(
            claims: Annotated[Claims, Depends(self.authenticate)],
            restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        ) -> None:
            if claims.role != SYSTEM_ADMIN and claims.restaurant_id != restaurant_id:
                raise ERR_PERMISSION_DENIED

        return guard

    def require(self, permission: str) -> Callable[..., Awaitable[None]]:
        """Same rule as core's `rbac()`: admins pass, restaurant users need the permission on their role."""

        async def guard(claims: Annotated[Claims, Depends(self.authenticate)]) -> None:
            if claims.role == SYSTEM_ADMIN:
                return
            if claims.role != RESTAURANT_USER or not claims.restaurant_role:
                raise ERR_PERMISSION_DENIED
            if permission not in await self._permissions.get(claims.restaurant_role):
                raise ERR_PERMISSION_DENIED

        return guard
