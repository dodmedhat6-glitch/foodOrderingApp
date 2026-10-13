"""Permission checks — order-service's ``rbac.ts``, as FastAPI dependencies.

Same semantics as core's and order-service's ``rbac()``:

- ``system_admin`` passes.
- ``restaurant_user`` passes if the permissions of their *restaurant role*
  (``owner``, ``manager``, …) include the one asked for.
- Everyone else is denied.

``require`` and ``require_restaurant_member`` are factories that return
dependencies, the way ``rbac({resource, action})`` returns middleware. Both
depend on ``Authenticate``; FastAPI runs a shared dependency once per
request and hands its result to everything that asked for it, so stacking
the two guards on one route verifies the token once.
"""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, Path

from lib.appcontext.context import Claims
from lib.auth.errors import ERR_PERMISSION_DENIED
from lib.auth.middleware import Authenticate
from lib.rbac.cache import PermissionsCache

SYSTEM_ADMIN = "system_admin"
RESTAURANT_USER = "restaurant_user"

Guard = Callable[..., Awaitable[None]]


class Rbac:
    def __init__(self, authenticate: Authenticate, permissions: PermissionsCache) -> None:
        self._authenticate = authenticate
        self._permissions = permissions

    def require(self, permission: str) -> Guard:
        """``rbac({resource: "analytics", action: "read"})`` ≡ ``require("analytics:read")``."""

        async def guard(claims: Annotated[Claims, Depends(self._authenticate)]) -> None:
            if claims.role == SYSTEM_ADMIN:
                return
            if claims.role != RESTAURANT_USER or not claims.restaurant_role:
                raise ERR_PERMISSION_DENIED
            if permission not in await self._permissions.get(claims.restaurant_role):
                raise ERR_PERMISSION_DENIED

        return guard

    def require_restaurant_member(self) -> Guard:
        """The caller must belong to the restaurant named in the path.

        The id is declared as a validated path parameter, so a malformed
        ``restaurantId`` is a 400 from validation rather than a 403 from
        here — the guard is never even called with a value it cannot read.
        """

        async def guard(
            claims: Annotated[Claims, Depends(self._authenticate)],
            restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        ) -> None:
            if claims.role == SYSTEM_ADMIN:
                return
            if claims.restaurant_id != restaurant_id:
                raise ERR_PERMISSION_DENIED

        return guard
