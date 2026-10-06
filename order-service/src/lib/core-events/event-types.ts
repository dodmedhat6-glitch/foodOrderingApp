/**
 * The routing keys core publishes, which are also its event types.
 *
 * This is the whole catalog — core emits one coarse `invalidated` event per
 * entity type (its lib/events/events.ts), not the granular
 * `product.stock.changed` / `branch.deactivated` / `rbac.permissions_changed`
 * set that earlier drafts of CLAUDE.md s8 and docs/implementation-plan.md
 * describe. A binding like `product.#` matches none of these, so a service
 * configured against that older catalog consumes nothing at all; the queue
 * binds `core.#`.
 *
 * What each event *carries* is a separate question from what it is called:
 * core's payloads now include the values its writing transaction committed
 * where it has them, which is what lets the handlers patch a projection
 * instead of dropping it. See lib/core-client/projection.service.ts.
 */
export const CoreEventType = {
    BRANCH_INVALIDATED: "core.branch.invalidated",
    PRODUCT_INVALIDATED: "core.product.invalidated",
    RESTAURANT_INVALIDATED: "core.restaurant.invalidated",
    ADDRESS_INVALIDATED: "core.address.invalidated",
    USER_INVALIDATED: "core.user.invalidated",
} as const;
