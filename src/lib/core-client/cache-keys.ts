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

export function branchKey(branchId: number): string {
    return `core:branch:${branchId}`;
}

export function productKey(branchId: number, productId: number): string {
    return `core:product:${branchId}:${productId}`;
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
