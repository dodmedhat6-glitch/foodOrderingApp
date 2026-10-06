import {PaymentMethod} from "../order/enums";
import {PaymentSessionStatus, TransactionMethod, TransactionStatus, TransactionType} from "./enums";

/**
 * Module-level helper shapes shared between the repos, services and
 * controllers, so none of those files declares an inline interface
 * (CLAUDE.md s5.10).
 */

/** Everything the repo needs to insert one `payment_sessions` row. */
export interface CreatePaymentSessionRow {
    region: string;
    orderId: number;
    orderPublicId: string;
    providerId: number;
    merchantOrderRef: string;
    providerSessionId: string;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    expiresAt: Date;
    rawInitPayload: Record<string, unknown>;
}

/**
 * A session advance. Everything optional but `status`: a webhook tells us
 * only what it knows, and writing a column we weren't told about would
 * overwrite a value we already learned with nothing.
 */
export interface UpdatePaymentSessionInput {
    status: PaymentSessionStatus;
    providerOrderId?: string;
    rawLastPayload?: unknown;
}

/** Everything the repo needs to insert one `transactions` row. */
export interface CreateTransactionInput {
    region: string;
    orderId: number | null;
    orderPublicId: string | null;
    type: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId?: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    refundedPaymentId?: number | null;
    idempotencyKey?: string | null;
}

/** One `payment_webhook_events` row, as received. */
export interface CreateWebhookEventInput {
    region: string;
    providerId: number;
    providerEventId: string;
    eventType: string;
    signature: string;
    payload: unknown;
}

/**
 * The region and order a webhook's merchant reference decodes to.
 *
 * A webhook arrives with no `X-Region` header — the provider has never heard
 * of our sharding — so the region has to travel inside the one field the HMAC
 * signs, which is the reference we chose at session creation.
 */
export interface MerchantOrderRef {
    region: string;
    orderPublicId: string;
    attempt: number;
}

/** What the webhook service reports back to its controller. */
export interface WebhookProcessingResult {
    /** False when the event had already been processed; no side effects ran. */
    processed: boolean;
    reason?: string;
}

/** Everything a payment call needs that isn't in its body or path. */
export interface PaymentCallContext {
    region: string;
    correlationId?: string;
    idempotencyKey?: string;
}

/**
 * The payment block the order module puts on `GET /api/orders/{publicId}`.
 *
 * Declared here rather than in the order module because this module computes
 * it: the order module owns the wire DTO and this is the shape that fills it,
 * which keeps the dependency pointing one way (orders asks payments, never
 * the reverse).
 */
export interface OrderPaymentSummary {
    method: PaymentMethod;
    status: "pending" | "authorized" | "captured" | "failed" | "refunded";
    amount: number;
    currency: string;
    refundedAmount: number;
}
