from pydantic import BaseModel, ConfigDict


class _CoreModel(BaseModel):
    # Core may add fields; a new field upstream must not break us.
    model_config = ConfigDict(extra="ignore")


class PermissionEntry(_CoreModel):
    permission: str  # "resource:action", pre-flattened by core


class RolePermissionsLookup(_CoreModel):
    """``GET /api/roles/{role}/permissions`` — core's ``memberService.getRolePermissions``.

    A hand-maintained contract with core, same as order-service's
    ``RolePermissionsLookup``: a mismatch is a ``ValidationError`` here at
    runtime, not a type error over there.
    """

    role: str
    permissions: list[PermissionEntry]
