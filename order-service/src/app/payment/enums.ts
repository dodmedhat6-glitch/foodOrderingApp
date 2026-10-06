// Values match the CHECK constraints in
// migrations/20260418000040_create_payment_sessions.ts and
// migrations/20260418000050_create_transactions.ts.

/** Row names in the replicated `payment_providers` lookup. */
export enum PaymentProviderName {
    KASHIER = "kashier",
    COD = "cod",
}

/**
 * The payment session lifecycle. A superset of what Kashier reports, because
 * it also has to express states we reach on our own: `expired` is written by
 * the sweep, not by the provider.
 */
export enum PaymentSessionStatus {
    INITIALIZED = "initialized",
    PENDING = "pending",
    AUTHORIZED = "authorized",
    CAPTURED = "captured",
    FAILED = "failed",
    EXPIRED = "expired",
    CANCELLED = "cancelled",
}

/** Sessions a customer can still pay — the ones init re-uses and the sweep ends. */
export const OPEN_SESSION_STATUSES: readonly PaymentSessionStatus[] = [
    PaymentSessionStatus.INITIALIZED,
    PaymentSessionStatus.PENDING,
    PaymentSessionStatus.AUTHORIZED,
];

/**
 * What a ledger row is *for*. Direction is not encoded here — it comes from
 * `(type, srcAccId, dstAccId)`, where a null account is the platform.
 */
export enum TransactionType {
    CHARGE = "charge",
    REFUND = "refund",
    COMMISSION = "commission",
    PAYOUT = "payout",
    COD_COLLECTION = "cod_collection",
    ADJUSTMENT = "adjustment",
}

/** How the money moved. `system` is an internal movement with no rail. */
export enum TransactionMethod {
    ONLINE = "online",
    COD = "cod",
    BANK_TRANSFER = "bank_transfer",
    SYSTEM = "system",
}

export enum TransactionStatus {
    PENDING = "pending",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    REVERSED = "reversed",
}

/**
 * Payment events pushed to the customer's socket. The order's own lifecycle
 * events stay in `OrderWsEvent` — a capture produces both: `payment.captured`
 * here and `order.status_changed` from the order module.
 */
export enum PaymentWsEvent {
    CAPTURED = "payment.captured",
    FAILED = "payment.failed",
    REFUNDED = "payment.refunded",
}
