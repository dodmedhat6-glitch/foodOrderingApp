import {Router} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {rbac, requireBranchAccess, requireRestaurantMember} from "../../lib/auth/rbac";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {PaymentController} from "./controller/payment.controller";
import {PaymentWebhookController} from "./controller/webhook.controller";

export const paymentRouter = Router();
const paymentController = container.resolve<PaymentController>(TOKENS.PaymentController);
const webhookController = container.resolve<PaymentWebhookController>(
    TOKENS.PaymentWebhookController,
);

/**
 * `POST /api/payments/webhook/:provider` — the provider callback.
 *
 * Declared first so nothing in front of it can reject the call: it carries
 * no cookie, no bearer token and no region header, because the provider has
 * none of them. Its authentication is the HMAC over the payload, verified in
 * the service against the Payment API Key before a single row is read.
 *
 * No idempotency middleware either — that one keys off a client-supplied
 * `Idempotency-Key`, and the provider doesn't send one. De-duplication here
 * is the unique `(provider_id, provider_event_id)` on
 * `payment_webhook_events`, with the unique `transactions.idempotency_key`
 * underneath it.
 */
paymentRouter.post("/payments/webhook/:provider", webhookController.receive);

/**
 * POST /api/payments/init — strict idempotency: this is where money starts.
 *
 * `requireRole(CUSTOMER)` rather than `rbac()`, because the question is who
 * the caller is, not what their restaurant role permits. The ownership check
 * ("is this your order") belongs to the service, which has the order.
 */
paymentRouter.post(
    "/payments/init",
    authenticate,
    requireRegion,
    requireRole(SystemRole.CUSTOMER),
    idempotency({strict: true}),
    paymentController.init,
);

/**
 * A payment is read under two paths, for the same reason orders are
 * (app/order/routes.ts):
 *
 *  - `GET /api/restaurants/:restaurantId/branches/:branchId/payments/:paymentId`
 *    — restaurant staff. `payments:read` is a permission in core's catalog,
 *    seeded onto `owner` alone (docs/business-logic/rbac.md), and checking a
 *    permission against a tenant resource is exactly what wants the tenancy in
 *    the path: `requireRestaurantMember` and `requireBranchAccess` then run as
 *    middleware, and the branch travels into the order lookup behind the
 *    payment so the read is filtered by it rather than merely checked against
 *    it.
 *  - `GET /api/payments/:paymentId` — system admins, who have no restaurant or
 *    branch to name and would otherwise have to guess a pair to satisfy the
 *    nested path. Kept role-gated rather than rbac-gated so the flat route
 *    cannot become a way around the permission check above.
 *
 * Neither is cached: a payment's status is exactly the thing a caller is
 * polling for, and the read is a single primary-key lookup.
 */
export const restaurantPaymentRouter = Router({mergeParams: true});

restaurantPaymentRouter.get(
    "/payments/:paymentId",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    rbac({resource: "payments", action: "read"}),
    paymentController.getById,
);

paymentRouter.use("/restaurants/:restaurantId/branches/:branchId", restaurantPaymentRouter);

paymentRouter.get(
    "/payments/:paymentId",
    authenticate,
    requireRegion,
    requireRole(SystemRole.SYSTEM_ADMIN),
    paymentController.getById,
);

/**
 * POST /api/payments/:paymentId/refund — admin only, strict idempotency.
 *
 * `requireRole(SYSTEM_ADMIN)` and not an `rbac()` permission: refunding is
 * not a restaurant capability in this milestone, and there is no
 * `payments:refund` in core's catalog to check against. Giving it one would
 * be inventing a permission core doesn't seed.
 */
paymentRouter.post(
    "/payments/:paymentId/refund",
    authenticate,
    requireRegion,
    requireRole(SystemRole.SYSTEM_ADMIN),
    idempotency({strict: true}),
    paymentController.refund,
);
