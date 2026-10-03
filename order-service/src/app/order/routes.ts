import {Router, Request} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {rbac, requireBranchAccess} from "../../lib/auth/rbac";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {withCache} from "../../lib/cache/withCache";
import {env} from "../../lib/config/env";
import {OrderController} from "./controller/order.controller";

export const orderRouter = Router();
const orderController = container.resolve<OrderController>(TOKENS.OrderController);

/**
 * Every route needs a concrete region: the order lives on exactly one shard
 * and nothing here is an admin fan-out read, so `requireRegion` runs before
 * the handler rather than letting the controller discover a missing header
 * after it has already validated a body.
 *
 * Authorization splits two ways on purpose (CLAUDE.md s8/RBAC):
 *  - `requireRole` where the question is *who* the caller is — placing an
 *    order is a customer action, full stop, and the ownership check that
 *    follows is in the service.
 *  - `rbac()` where the question is a permission in core's catalog — the
 *    restaurant dashboard is gated on `orders:read`, which core seeds per
 *    restaurant role.
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

/**
 * GET /api/restaurant/orders — the kitchen dashboard, polled hard, so it is
 * the one order read behind a cache. TTL is deliberately short
 * (RESTAURANT_ORDERS_CACHE_TTL_SEC, 10s by default) and every status
 * transition invalidates the branch's whole family of cached pages
 * explicitly; the TTL is only the backstop for a missed invalidation.
 *
 * The key is built by hand rather than from the URL so that the branch id sits
 * at a fixed position, which is what lets `order.service` clear every query
 * permutation for one branch with a single pattern delete.
 */
orderRouter.get(
    "/restaurant/orders",
    authenticate,
    requireRegion,
    rbac({resource: "orders", action: "read"}),
    requireBranchAccess("branchId"),
    withCache(env.orders.restaurantListCacheTtlSec, false, restaurantOrdersCacheKey),
    orderController.listForRestaurant
);

// GET /api/orders/:orderId — declared after the two list routes so that
// "customer" and "restaurant" can never be read as an :orderId.
orderRouter.get("/orders/:orderId", authenticate, requireRegion, orderController.getByPublicId);

// PATCH /api/orders/:orderId/status — the single status endpoint (CLAUDE.md s4).
// Which targets are legal for this caller is decided by the status machine,
// not by the route, so there is one route rather than one per transition.
orderRouter.patch(
    "/orders/:orderId/status",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.updateStatus
);

/**
 * `restaurant:orders:<branchId>:<every other filter>`. The prefix through the
 * branch id is the invalidation handle — see
 * `OrderService.invalidateBranchOrderLists`.
 */
function restaurantOrdersCacheKey(req: Request): string {
    const q = req.query as Record<string, unknown>;
    const parts = [q.status, q.from, q.to, q.cursor, q.limit, q.sortBy, q.sortOrder].map((v) =>
        v === undefined ? "" : String(v)
    );
    return `restaurant:orders:${String(q.branchId ?? "")}:${parts.join(":")}`;
}
