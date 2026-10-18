import {Router} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {DeliveryController} from "./controller/delivery.controller";

export const deliveryRouter = Router();
const deliveryController = container.resolve<DeliveryController>(TOKENS.DeliveryController);

/**
 * Dispatch routes hang off `/orders/:orderId` rather than a `/deliveries`
 * resource, because there is no delivery resource: a delivery is a phase of an
 * order and the order's public id is the only handle (docs/database-design.md
 * s3.7).
 *
 * `picked` and `delivered` are absent on purpose — they are order transitions
 * and go through `PATCH /api/orders/:orderId/status`, which routes an agent's
 * targets into this module (CLAUDE.md s4: one status endpoint per resource).
 */

/**
 * POST /api/orders/:orderId/claim
 *
 * **Not** idempotency-guarded, and that is the interesting decision. The
 * endpoint is already idempotent where it matters: the conditional UPDATE
 * means a replay by the agent who won returns their own order, and a replay by
 * anyone else returns 409 — the same answers the first call gave. An
 * idempotency record would add a Redis round trip to the one endpoint in the
 * service whose latency decides a race between agents.
 */
deliveryRouter.post(
    "/orders/:orderId/claim",
    authenticate,
    requireRegion,
    requireRole(SystemRole.DELIVERY_AGENT),
    deliveryController.claim,
);

deliveryRouter.post(
    "/orders/:orderId/unclaim",
    authenticate,
    requireRegion,
    requireRole(SystemRole.DELIVERY_AGENT),
    deliveryController.unclaim,
);

/**
 * POST /api/orders/:orderId/assign — the admin override.
 *
 * Strict idempotency here, unlike the claim: this one *is* replayable into a
 * different outcome. A retried request with a different `agentId` after the
 * first succeeded would be refused by the status check, but a retried
 * identical request racing itself could bounce an order between two writes.
 * Gated by role rather than an RBAC permission, so nothing new needs seeding
 * in core's catalog.
 */
deliveryRouter.post(
    "/orders/:orderId/assign",
    authenticate,
    requireRegion,
    requireRole(SystemRole.SYSTEM_ADMIN),
    idempotency({strict: true}),
    deliveryController.assign,
);
