import {Router, Request} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {rbac, requireBranchAccess, requireRestaurantMember} from "../../lib/auth/rbac";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {withCache} from "../../lib/cache/withCache";
import {env} from "../../lib/config/env";
import {OrderController} from "./controller/order.controller";
import {OrderStatus} from "./enums";

export const orderRouter = Router();
const orderController = container.resolve<OrderController>(TOKENS.OrderController);

/**
 * Every route needs a concrete region: the order lives on exactly one shard
 * and nothing here is an admin fan-out read, so `requireRegion` runs before
 * the handler rather than letting the controller discover a missing region
 * after it has already validated a body.
 *
 * The module exposes the same orders under two prefixes, because the two
 * audiences are authorized by different questions (CLAUDE.md s8/RBAC):
 *
 *  - **Caller-scoped** — `/orders`, `/customer/orders`. The subject is the
 *    JWT: a customer placing and tracking their own order, an agent moving the
 *    one they carry. `requireRole` plus the ownership check in the service is
 *    the whole of it; there is no tenant resource to authorize against beyond
 *    the order itself.
 *  - **Restaurant-scoped** — `/restaurants/:restaurantId/branches/:branchId/*`.
 *    The subject *is* a tenant resource, so the tenancy belongs in the path,
 *    which is what lets `requireRestaurantMember` and `requireBranchAccess`
 *    run as middleware exactly as they do in `core-service`. Reading the
 *    branch from a query param instead would mean the guard and the handler
 *    each had to remember to look in the same place.
 *
 * That the restaurant path is nested is not only cosmetic: the scope travels
 * into the repository, so every scoped read *filters* by `(restaurant_id,
 * branch_id)` alongside the order id rather than fetching a row and rejecting
 * it afterwards (see `app/order/types.ts` -> `OrderScope`).
 */

// POST /api/orders — strict idempotency: this is the endpoint that costs money.
orderRouter.post(
    "/orders",
    authenticate,
    requireRegion,
    requireRole(SystemRole.CUSTOMER),
    idempotency({strict: true}),
    orderController.create
);

// GET /api/customer/orders?year=YYYY — the customer's own history.
// Not cached: a customer polling their own order expects to see a status
// change immediately, and the read is already a single indexed scan.
orderRouter.get(
    "/customer/orders",
    authenticate,
    requireRegion,
    requireRole(SystemRole.CUSTOMER),
    orderController.listForCustomer
);

// GET /api/orders/:orderId — the caller-scoped read, for a customer tracking
// their order or an agent looking at their delivery. Declared after
// /customer/orders so "customer" can never be read as an :orderId.
orderRouter.get("/orders/:orderId", authenticate, requireRegion, orderController.getByPublicId);

/**
 * PATCH /api/orders/:orderId/status — the caller-scoped transition: a customer
 * cancelling inside their window, an agent marking picked or delivered.
 *
 * Restaurant staff have their own copy of this route under the nested prefix,
 * because theirs is the one whose authorization is a permission in core's
 * catalog rather than a role. Which targets are legal for a given caller is
 * still decided by the status machine, not by the route, so neither copy
 * enumerates transitions (CLAUDE.md s4).
 *
 * The role list is explicit so a restaurant user cannot reach the unscoped
 * handler and bypass the `rbac()` check their own route applies.
 */
orderRouter.patch(
    "/orders/:orderId/status",
    authenticate,
    requireRegion,
    requireRole(SystemRole.CUSTOMER, SystemRole.DELIVERY_AGENT, SystemRole.SYSTEM_ADMIN),
    idempotency({strict: true}),
    orderController.updateStatus
);

/**
 * The restaurant-facing surface, mounted under
 * `/api/restaurants/:restaurantId/branches/:branchId`.
 *
 * `mergeParams` is load-bearing: without it Express does not expose a mount
 * path's params to the child router, and both the branch guard and the
 * controller's scope parsing would see an empty `req.params`.
 */
export const restaurantOrderRouter = Router({mergeParams: true});

/**
 * Applied to every route below, in this order on purpose:
 *
 *  1. `authenticate` — there is no `req.user` to check anything against yet.
 *  2. `requireRegion` — a shard has to be chosen before a query exists.
 *  3. `requireRestaurantMember` — the caller's own restaurant must be the one
 *     in the path. This is the check that makes the nesting worth anything;
 *     without it `:restaurantId` would be a decoration.
 *  4. `requireBranchAccess` — and the branch must be one they belong to. An
 *     owner passes on the strength of (3).
 *
 * `rbac()` is deliberately *not* in this list: the required permission differs
 * per route, so each one names its own.
 */
const restaurantScope = [
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
];

/**
 * GET /api/restaurants/:restaurantId/branches/:branchId/orders — the kitchen
 * dashboard, polled hard, so it is the one order read behind a cache. TTL is
 * deliberately short (RESTAURANT_ORDERS_CACHE_TTL_SEC, 10s by default) and
 * every status transition invalidates the branch's whole family of cached
 * pages explicitly; the TTL is only the backstop for a missed invalidation.
 *
 * The key is built by hand rather than from the URL so that the branch id sits
 * at a fixed position, which is what lets `order.service` clear every query
 * permutation for one branch with a single pattern delete.
 */
restaurantOrderRouter.get(
    "/orders",
    ...restaurantScope,
    rbac({resource: "orders", action: "read"}),
    withCache(env.orders.restaurantListCacheTtlSec, false, restaurantOrdersCacheKey),
    orderController.listForRestaurant
);

// GET .../orders/:orderId — one order in full. Same permission as the list:
// the detail view is a list row expanded, not a further capability.
restaurantOrderRouter.get(
    "/orders/:orderId",
    ...restaurantScope,
    rbac({resource: "orders", action: "read"}),
    orderController.getByPublicId
);

/**
 * PATCH .../orders/:orderId/status — the restaurant transition.
 *
 * The permission depends on the target rather than on the route, because
 * core's catalog splits a restaurant's order rights three ways
 * (docs/business-logic/rbac.md s3): `staff` may accept and advance an order
 * but not cancel it, a `branch_manager` may do all three. Three routes would
 * contradict the one-status-endpoint rule, so the action is resolved from the
 * body instead — before anything is written, and against the same body
 * `validateBody` re-checks in the controller.
 */
restaurantOrderRouter.patch(
    "/orders/:orderId/status",
    ...restaurantScope,
    rbac({resource: "orders", action: orderStatusAction}),
    idempotency({strict: true}),
    orderController.updateStatus
);

orderRouter.use("/restaurants/:restaurantId/branches/:branchId", restaurantOrderRouter);

/**
 * Maps a requested status onto the permission it needs.
 *
 * An unrecognised target returns `undefined`, which `rbac()` treats as a
 * denial. That is the right answer here and not merely the safe one: the body
 * has not been validated yet at middleware time, so "not a status I know" and
 * "not a status at all" are the same case, and `validateBody` is about to
 * reject both.
 */
function orderStatusAction(req: Request): string | undefined {
    switch ((req.body as {status?: string} | undefined)?.status) {
        case OrderStatus.ACCEPTED:
        case OrderStatus.REJECTED:
            return "accept";
        case OrderStatus.PREPARING:
        case OrderStatus.READY:
            return "update";
        case OrderStatus.CANCELLED:
            return "cancel";
        default:
            return undefined;
    }
}

/**
 * `restaurant:orders:<branchId>:<every other filter>`. The prefix through the
 * branch id is the invalidation handle — see
 * `OrderService.invalidateBranchOrderLists`.
 *
 * The branch now comes from the path rather than the query string, so the key
 * no longer depends on the caller having spelled a query param; the rest of
 * the shape is unchanged, and so is the pattern the service deletes.
 */
function restaurantOrdersCacheKey(req: Request): string {
    const q = req.query as Record<string, unknown>;
    const parts = [q.status, q.from, q.to, q.cursor, q.limit, q.sortBy, q.sortOrder].map((v) =>
        v === undefined ? "" : String(v)
    );
    return `restaurant:orders:${String(req.params.branchId ?? "")}:${parts.join(":")}`;
}
