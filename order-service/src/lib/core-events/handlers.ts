import {cacheProvider} from "../cache/init";
import {logger} from "../logger/logger";
import {branchKey, restaurantSuspendedKey} from "../core-client/cache-keys";
import {registerHandler} from "./consumer";
import {CoreInvalidationPayload} from "./types";

/**
 * Inbound handlers for core-service's event catalog.
 *
 * What core actually publishes (its `lib/events/events.ts` + the
 * `enqueueOutboxEvent` call sites in its branch/product/restaurant services)
 * is a single coarse event per entity type:
 *
 *   core.branch.invalidated | core.product.invalidated |
 *   core.restaurant.invalidated | core.address.invalidated | core.user.invalidated
 *
 * with payload `{ id, occurredAt }` — the entity's id and nothing else. That
 * is narrower than the granular catalog docs/business-logic and CLAUDE.md s8
 * describe (`product.stock.changed`, `branch.deactivated`,
 * `rbac.permissions_changed`, ...), so the handlers below invalidate at the
 * granularity core gives us rather than the granularity we'd prefer:
 *
 *  - A product event doesn't say which branch changed, so every branch's
 *    projection of that product goes. Cheap: the keys are per branch+product
 *    and a restaurant has few branches.
 *  - `branch.deactivated` and `restaurant.suspended` don't exist as distinct
 *    events, so the reject-new-orders flag and the pending-order review flag
 *    documented for Phase 1 can't be driven from here. Deleting the branch
 *    projection is enough for correctness — placeOrder re-reads it from core
 *    and sees `acceptOrders: false` / a non-active restaurant status on the
 *    very next attempt — it just costs one upstream call instead of a Redis
 *    hit. See the note in docs/implementation-plan.md Phase 1.
 *  - Nothing core publishes signals an RBAC change, so the role-permission
 *    projection expires on its TTL alone (CORE_PERMISSIONS_TTL_SEC).
 *
 * Every handler is an idempotent delete, which is what makes the consumer's
 * at-least-once delivery and 24h Redis dedupe window safe.
 */

export const CoreEventType = {
    BRANCH_INVALIDATED: "core.branch.invalidated",
    PRODUCT_INVALIDATED: "core.product.invalidated",
    RESTAURANT_INVALIDATED: "core.restaurant.invalidated",
    ADDRESS_INVALIDATED: "core.address.invalidated",
    USER_INVALIDATED: "core.user.invalidated",
} as const;

export function registerCoreEventHandlers(): void {
    registerHandler(CoreEventType.BRANCH_INVALIDATED, async (payload) => {
        const branchId = entityId(payload, CoreEventType.BRANCH_INVALIDATED);
        await cacheProvider.del(branchKey(branchId));
        logger.info("core-events: branch projection invalidated", {branchId});
    });

    registerHandler(CoreEventType.PRODUCT_INVALIDATED, async (payload) => {
        const productId = entityId(payload, CoreEventType.PRODUCT_INVALIDATED);
        // Keys are core:product:<branchId>:<productId> and the event names no
        // branch, so the product goes from every branch that cached it.
        const deleted = await cacheProvider.delByPattern(`core:product:*:${productId}`);
        logger.info("core-events: product projection invalidated", {productId, keysDeleted: deleted});
    });

    registerHandler(CoreEventType.RESTAURANT_INVALIDATED, async (payload) => {
        const restaurantId = entityId(payload, CoreEventType.RESTAURANT_INVALIDATED);
        // The restaurant's trading status is read through the *branch*
        // projection (core joins it into the branch lookup), so that is what
        // has to go; a suspension must not survive in a cached branch row.
        const deleted = await cacheProvider.delByPattern("core:branch:*");
        await cacheProvider.del(restaurantSuspendedKey(restaurantId));
        logger.info("core-events: restaurant projection invalidated", {
            restaurantId,
            branchKeysDeleted: deleted,
        });
    });

    // Addresses and users are read through on every use and never cached
    // (see core-client/address.client.ts), so these are acked as no-ops rather
    // than left to the "no handler" warning — the distinction matters when
    // reading the logs for a missing handler.
    registerHandler(CoreEventType.ADDRESS_INVALIDATED, async () => {});
    registerHandler(CoreEventType.USER_INVALIDATED, async () => {});
}

/**
 * Core sends `{ id, occurredAt }`. A payload without a usable id is a contract
 * break rather than a transient fault, so it throws and the message goes to
 * the DLQ for inspection instead of being silently dropped.
 */
function entityId(payload: unknown, eventType: string): number {
    const id = Number((payload as CoreInvalidationPayload | undefined)?.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`${eventType}: payload has no usable entity id`);
    }
    return id;
}
