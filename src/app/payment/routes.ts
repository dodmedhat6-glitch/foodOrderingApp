import {Router} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {rbac} from "../../lib/auth/rbac";
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
 * GET /api/payments/:paymentId — gated on `payments:read`, which core seeds
 * onto `owner` alone (docs/business-logic/rbac.md). System admins bypass, as
 * everywhere. A restaurant user still only sees payments on their own
 * restaurant's orders; `rbac()` grants the capability, and the service
 * applies the tenancy.
 *
 * Not cached: a payment's status is exactly the thing a caller is polling
 * for, and the read is a single primary-key lookup.
 */
paymentRouter.get(
    "/payments/:paymentId",
    authenticate,
    requireRegion,
    rbac({resource: "payments", action: "read"}),
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
