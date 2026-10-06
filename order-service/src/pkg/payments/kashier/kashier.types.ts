/**
 * Kashier v3 wire shapes — only the fields this service sends or reads.
 *
 * Deliberately not a transcription of the whole API. Everything Kashier
 * returns that we don't act on stays in `raw_init_payload` /
 * `raw_last_payload` as JSONB, where it is available for an audit without
 * inviting code to depend on it.
 */

/** POST /v3/payment/sessions — request. */
export interface KashierCreateSessionRequest {
    merchantId: string;
    order: string;
    amount: string;
    currency: string;
    merchantRedirect: string;
    expireAt: string;
    maxFailureAttempts: number;
    type: string;
    display: string;
    /** Comma-separated. We send exactly "card,wallet". */
    allowedMethods: string;
    customer: {reference: string; email?: string};
    description?: string;
    serverWebhook?: string;
    /**
     * False so a failed attempt keeps the customer on Kashier's page and lets
     * them retry inside the same session, instead of bouncing them back to us
     * with an order we would then have to re-initialise.
     */
    failureRedirect: boolean;
}

/** POST /v3/payment/sessions — response (the fields we read). */
export interface KashierCreateSessionResponse {
    _id?: string;
    sessionUrl?: string;
    status?: string;
    expireAt?: string;
    merchantId?: string;
}

/** PUT /v3/payment/refund/{orderId} — request. */
export interface KashierRefundRequest {
    apiOperation: "REFUND";
    reason?: string;
    transaction: {amount: number; targetTransactionId?: string};
}

/** PUT /v3/payment/refund/{orderId} — response (the fields we read). */
export interface KashierOrderOperationResponse {
    status?: string;
    transactionId?: string;
    response?: {status?: string; transactionId?: string; [key: string]: unknown};
    messages?: unknown;
}

/**
 * The webhook envelope. `data` is loose on purpose: which of its fields are
 * authenticated is decided at runtime by `data.signatureKeys`, so typing it
 * tightly would imply a guarantee the wire format doesn't give.
 */
export interface KashierWebhookBody {
    event?: unknown;
    data?: Record<string, unknown>;
}

/** `data.status` values. Note these describe the transaction, not the order. */
export const KASHIER_STATUS = {
    SUCCESS: "SUCCESS",
    FAILURE: "FAILURE",
    PENDING: "PENDING",
} as const;

/**
 * `event` values Kashier sets. It is the *operation*, never an outcome — a
 * failed payment arrives as `pay` with `data.status = "FAILURE"` — so nothing
 * in this service may branch on it alone.
 */
export const KASHIER_EVENT = {
    PAY: "pay",
    AUTHORIZE: "authorize",
    CAPTURE: "capture",
    REFUND: "refund",
    PARTIAL_REFUND: "partial_refund",
    VOID: "void",
    REJECT: "reject",
    REVERSAL: "reversal",
} as const;
