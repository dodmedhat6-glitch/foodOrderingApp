"""In-process, read-through cache of role -> permissions.

order-service keeps this projection in Redis (``rbac.client.ts``) because it
runs many API replicas that should share one copy. This service is read-light
and holds no Redis connection at all, so the cache lives in process memory:
one dict per replica, a TTL as the backstop, ``invalidate(role)`` as the hook
the ``rbac.permissions_changed`` consumer will call (homework).

The loader is a Protocol, not the core client itself, so ``lib/rbac`` does
not care where permissions come from and a test can hand it a dict.
"""

import asyncio
import time
from collections.abc import Callable
from typing import Protocol

PermissionSet = frozenset[str]


class PermissionsLoader(Protocol):
    async def get_role_permissions(self, role: str) -> PermissionSet: ...


class PermissionsCache:
    def __init__(
        self,
        loader: PermissionsLoader,
        ttl_sec: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._ttl = ttl_sec
        self._clock = clock  # monotonic: a wall-clock jump must not expire or immortalize entries
        self._entries: dict[str, tuple[float, PermissionSet]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, role: str) -> PermissionSet:
        hit = self._fresh(role)
        if hit is not None:
            return hit

        # Single-flight: when a cold or just-expired role is requested by 50
        # concurrent requests, one of them calls core and the other 49 wait
        # for its answer instead of sending 49 more identical requests.
        lock = self._locks.setdefault(role, asyncio.Lock())
        async with lock:
            hit = self._fresh(role)  # filled while we waited for the lock
            if hit is not None:
                return hit
            permissions = await self._loader.get_role_permissions(role)
            self._entries[role] = (self._clock() + self._ttl, permissions)
            return permissions

    def invalidate(self, role: str | None = None) -> None:
        """Drop one role, or everything. The next ``get`` reloads from core."""
        if role is None:
            self._entries.clear()
        else:
            self._entries.pop(role, None)

    def _fresh(self, role: str) -> PermissionSet | None:
        entry = self._entries.get(role)
        if entry is None:
            return None
        expires_at, permissions = entry
        return permissions if self._clock() < expires_at else None
