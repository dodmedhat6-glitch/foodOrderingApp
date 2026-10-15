/**
 * Redis keys for core-service's own caches.
 *
 * Separate from the `core:*` keys order-service uses: that service runs
 * against its own Redis in production, so the two namespaces never meet and a
 * key here is only ever read and invalidated by this service.
 *
 * Every key defined here must have an explicit invalidation site. A TTL alone
 * is not acceptable for operational flags (a branch's `isActive`,
 * `acceptOrders`, a restaurant's `status`) — order-service refuses orders on
 * those, and a stale copy here would survive its own correct invalidation.
 */

/**
 * `GET /api/internal/branches/:id` — the joined branch+restaurant lookup
 * order-service reads on *every* order placement, by far the hottest internal
 * endpoint. Cached at the service rather than in `withCache` middleware so the
 * key is a plain branch id: the writers that have to invalidate it
 * (branch.service update/updateStatus, restaurant.service updateStatus) know
 * the branch id, not the caller's URL.
 */
export function internalBranchLookupKey(branchId: number): string {
    return `internal:branch:${branchId}`;
}

/** Short on purpose: explicit invalidation is the mechanism, this is the backstop. */
export const INTERNAL_BRANCH_LOOKUP_TTL_SEC = 300;
