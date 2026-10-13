from urllib.parse import quote

from pydantic import ValidationError

from lib.coreclient.client import CoreClient
from lib.coreclient.errors import ERR_CORE_BAD_RESPONSE
from lib.coreclient.types import RolePermissionsLookup
from lib.rbac.cache import PermissionSet


class CoreRbacClient:
    """Role -> permissions, straight from core. Satisfies ``lib.rbac.cache.PermissionsLoader``.

    Uses the endpoint core actually serves, ``GET /api/roles/{role}/permissions``
    on its public rbac router — the same one order-service's ``rbac.client.ts``
    reads. Core has no ``/api/internal/rbac/...`` route. The api-key header is
    still sent: harmless on a public route, and already right if core ever
    moves the lookup behind ``apiKeyAuth``.
    """

    def __init__(self, core: CoreClient) -> None:
        self._core = core

    async def get_role_permissions(self, role: str) -> PermissionSet:
        data = await self._core.call("GET", f"/api/roles/{quote(role, safe='')}/permissions")
        try:
            lookup = RolePermissionsLookup.model_validate(data)
        except ValidationError as exc:
            raise ERR_CORE_BAD_RESPONSE from exc
        # A frozenset so the guard's check is a hash lookup, not a list scan.
        return frozenset(entry.permission for entry in lookup.permissions)
