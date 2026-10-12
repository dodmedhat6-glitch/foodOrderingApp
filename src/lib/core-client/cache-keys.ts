/**
 * Redis keys for projections of core-service data.
 *
 * Deliberately NOT region-prefixed (unlike this service's own order keys):
 * branches, products and roles live once in core, so a projection of them is
 * the same value on every shard, and one invalidation event should clear it
 * everywhere. The `core:` prefix is also what the inbound core-events handlers
 * pattern-match on — see lib/core-client/projection.service.ts.
 */

export const CORE_BRANCH_TTL_SEC = 60;
export const CORE_PRODUCT_TTL_SEC = 30;
export const CORE_PERMISSIONS_TTL_SEC = 300;
/**
 * Short, because the only thing it holds is a display name on a screen the
 * customer is actively refreshing — and because `core.user.invalidated`
 * clears it anyway, so the TTL is the backstop for a missed event, not the
 * mechanism.
 */
export const CORE_USER_TTL_SEC = 60;

export function branchKey(branchId: number): string {
    return `core:branch:${branchId}`;
}

export function productKey(branchId: number, productId: number): string {
    return `core:product:${branchId}:${productId}`;
}

/** Display identity (name) for a user core owns — see user.client.ts. */
export function userKey(userId: number): string {
    return `core:user:${userId}`;
}

export function rolePermissionsKey(role: string): string {
    return `core:rbac:perms:${role}`;
}

/**
 * Set while a branch is known to be deactivated, so order placement can be
 * refused without waiting for the branch projection's TTL to lapse. Written by
 * the `branch.deactivated` handler, cleared by `branch.updated`.
 */
export function branchRejectingOrdersKey(branchId: number): string {
    return `core:branch:rejecting:${branchId}`;
}

/**
 * Set when a restaurant is suspended; its pending orders are flagged for
 * review by the ops team (docs/implementation-plan.md Phase 1).
 */
export function restaurantSuspendedKey(restaurantId: number): string {
    return `core:restaurant:suspended:${restaurantId}`;
}
