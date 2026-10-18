/**
 * Cross-service event catalog for the core-service -> order-service link.
 *
 * Nothing here publishes. Callers enqueue an outbox row in the same
 * transaction as the domain write (see app/outbox/repository/outbox.repo.ts
 * `enqueueOutboxEvent`); worker.ts drains those rows onto the `core.events`
 * topic exchange with publisher confirms. `eventType` is the AMQP routing
 * key, so `core.<entity>.invalidated` is the contract order-service binds
 * against: queue `order-service.core-events`, binding `core.#`, handled in
 * its `lib/core-events/handlers.ts`.
 *
 * Two halves of that contract are load-bearing, and changing either side
 * alone breaks cache invalidation silently:
 *
 *  - The routing key shape. A `core.*` binding would match none of these,
 *    hence `core.#` on the consumer.
 *  - The payload: `{ id, occurredAt }`. The drain wraps it in an envelope
 *    carrying eventId/eventType/entityType/entityId, and order-service
 *    dedupes on eventId since delivery is at-least-once.
 *
 * We deliberately emit one coarse invalidated event per entity type rather
 * than fine-grained ones (no stock.changed, price.changed, deactivated,
 * suspended). order-service relies on that: deleting its branch projection
 * is enough, because the next order placement re-reads from core and sees
 * the current acceptOrders/status. See order-service's docs/system-design.md
 * and docs/implementation-plan.md Phase 1.
 *
 * `invalidationChannel` is vestigial: it names the Redis Pub/Sub channel
 * from the design that preceded RabbitMQ, and is still persisted in
 * outbox_events.channel, but the drain routes on `eventType` alone and
 * nothing reads the column. Safe to drop together with the column.
 */

export type InvalidatedEntityType = "product" | "branch" | "restaurant" | "address" | "user";

export interface InvalidationPayload {
    id: number;
    occurredAt: string;
}

export function invalidationChannel(entityType: InvalidatedEntityType): string {
    return `core:invalidate:${entityType}`;
}

export function buildInvalidationPayload(id: number, occurredAt: Date = new Date()): InvalidationPayload {
    return { id, occurredAt: occurredAt.toISOString() };
}

export function invalidationEventType(entityType: InvalidatedEntityType): string {
    return `core.${entityType}.invalidated`;
}

/**
 * Richer payloads for the two entities order-service keeps a *projection* of
 * rather than just a cached read.
 *
 * The base `{ id, occurredAt }` only lets a consumer delete its copy. Where
 * the writing transaction already holds the new values, we ship them: the
 * consumer can then patch its projection in place instead of dropping it and
 * paying an HTTP round trip on the next order placement. Both are additive
 * supersets of `InvalidationPayload`, so a consumer that ignores the extra
 * fields keeps working exactly as before — order-service's handlers fall back
 * to a delete whenever a field it needs is absent.
 *
 * Only facts the transaction actually wrote go in here. A guess would be worse
 * than no field at all, because the consumer would cache it.
 */
export interface BranchInvalidationPayload extends InvalidationPayload {
    isActive?: boolean;
    acceptOrders?: boolean;
}

/**
 * `branchId` is what makes the rest usable: order-service keys its product
 * projection per branch+product, so a payload without it can only be handled
 * as a delete across every branch.
 */
export interface ProductInvalidationPayload extends InvalidationPayload {
    branchId?: number;
    unitPriceMinor?: number;
    stock?: number;
    isAvailable?: boolean;
}

export function buildBranchInvalidationPayload(
    id: number,
    fields: Omit<BranchInvalidationPayload, "id" | "occurredAt"> = {},
    occurredAt: Date = new Date()
): BranchInvalidationPayload {
    return { ...buildInvalidationPayload(id, occurredAt), ...definedOnly(fields) };
}

export function buildProductInvalidationPayload(
    id: number,
    fields: Omit<ProductInvalidationPayload, "id" | "occurredAt"> = {},
    occurredAt: Date = new Date()
): ProductInvalidationPayload {
    return { ...buildInvalidationPayload(id, occurredAt), ...definedOnly(fields) };
}

/**
 * Drops keys whose value is undefined. The payload is persisted as JSON, where
 * `{"stock": undefined}` and a missing `stock` serialise the same — but an
 * explicit `null` would not, and the consumer treats "present" as "trustworthy".
 */
function definedOnly<T extends object>(fields: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
    ) as Partial<T>;
}
