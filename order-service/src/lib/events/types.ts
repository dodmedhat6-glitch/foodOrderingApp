export enum OutboxStatus {
    PENDING = "pending",
    PUBLISHED = "published",
    FAILED = "failed",
}

/** An `events_outbox` row. */
export interface OutboxEvent {
    id: number;
    eventId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    payload: object;
    status: OutboxStatus;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    publishedAt: Date | null;
}

export interface EnqueueOutboxEventInput {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: object;
}

/**
 * What actually goes on the wire. Same shape core's drain publishes, so a
 * consumer of both exchanges parses one envelope.
 *
 * `occurredAt` is when the outbox row was written — i.e. when the domain
 * write committed — not when the drain got round to publishing it. A broker
 * outage must not shift an event into a later day on a consumer's rollup.
 */
export interface OutboundEventEnvelope {
    eventId: string;
    eventType: string;
    occurredAt: string;
    entityType: string;
    entityId: string;
    payload: object;
}

export interface DrainResult {
    region: string;
    published: number;
    failed: number;
}

/**
 * `order.placed`. Money in integer minor units with `currency` beside it,
 * timestamps ISO-8601 UTC — the same rules as the HTTP response DTOs
 * (CLAUDE.md s6), because a consumer is just another client.
 *
 * `orderId` is the public UUIDv7; the bigserial never leaves this service.
 */
export interface OrderPlacedPayload {
    orderId: string;
    region: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    status: string;
    paymentMethod: string;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
    items: OrderPlacedItemPayload[];
    placedAt: string;
}

export interface OrderPlacedItemPayload {
    productId: number;
    quantity: number;
    unitPriceMinor: number;
    lineTotal: number;
}
