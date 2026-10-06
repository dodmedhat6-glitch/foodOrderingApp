/**
 * A handler receives the event's payload and the envelope metadata around it.
 *
 * The metadata is passed because a handler that does more than touch Redis
 * needs it: `correlationId` threads an inbound event into any outbound core
 * call or log line it causes, so one customer action stays traceable across
 * both services, and `eventId` identifies the exact delivery in a log.
 */
export type CoreEventHandler = (payload: unknown, meta: CoreEventMeta) => Promise<void>;

export interface CoreEventMeta {
    eventId: string;
    eventType: string;
    occurredAt: string;
    /**
     * Reuses the eventId when core sends no correlation of its own, so an
     * outbound call caused by this event is always attributable to something.
     */
    correlationId: string;
}

export interface CoreEventEnvelope {
    eventId: string;
    eventType: string;
    occurredAt: string;
    correlationId?: string;
    payload: unknown;
}

/**
 * The floor of every `core.<entity>.invalidated` payload — core's
 * `buildInvalidationPayload`. The entity's id is the one field always present.
 */
export interface CoreInvalidationPayload {
    id: number;
    occurredAt: string;
}

/**
 * `core.branch.invalidated`, as core's `buildBranchInvalidationPayload` sends
 * it: the base payload plus the trading flags the writing transaction
 * committed, when it committed any.
 *
 * Every added field is optional, and that is the contract, not laxity — core
 * omits a field it did not write rather than sending a stale or guessed value,
 * so "present" means "true as of occurredAt". A handler must therefore treat
 * absence as "unknown", never as a default.
 */
export interface CoreBranchInvalidationPayload extends CoreInvalidationPayload {
    isActive?: boolean;
    acceptOrders?: boolean;
}

/** `core.product.invalidated` — core's `buildProductInvalidationPayload`. */
export interface CoreProductInvalidationPayload extends CoreInvalidationPayload {
    branchId?: number;
    unitPriceMinor?: number;
    stock?: number;
    isAvailable?: boolean;
}
