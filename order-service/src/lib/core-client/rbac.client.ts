import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {CORE_PERMISSIONS_TTL_SEC, rolePermissionsKey} from "./cache-keys";
import {CoreCallContext, RolePermissionsLookup} from "./types";

export type PermissionSet = ReadonlySet<string>;

/**
 * This service keeps no permissions catalog of its own (CLAUDE.md s8/RBAC):
 * core owns the table, and we hold a read-through projection keyed by role.
 * Invalidated by core's `rbac.permissions_changed` event; the TTL is the
 * backstop.
 *
 * Returned as a Set of `"resource:action"` so the middleware's check is a hash
 * lookup rather than a scan per request.
 */
export async function getRolePermissions(
    role: string,
    ctx: CoreCallContext = {},
): Promise<PermissionSet> {
    const key = rolePermissionsKey(role);

    const cached = await cacheProvider.get(key).catch(() => null);
    if (cached) return new Set(JSON.parse(cached) as string[]);

    const lookup = await coreClient.call<RolePermissionsLookup>({
        method: "GET",
        path: `/api/roles/${encodeURIComponent(role)}/permissions`,
        correlationId: ctx.correlationId,
    });

    const flattened = lookup.permissions.map((p) => p.permission);
    await cacheProvider.set(key, JSON.stringify(flattened), CORE_PERMISSIONS_TTL_SEC).catch(() => {});

    return new Set(flattened);
}
