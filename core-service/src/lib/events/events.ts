/**
 * Cross-service event catalog for the core-service -> order-service link.
 * Channel/payload shape here is a fixed contract: order-service's
 * `lib/cache/invalidation-subscriber.ts` psubscribes to `core:invalidate:*`
 * and expects a JSON payload with an `id` field (see order-service's
 * docs/01-system-design.md §5.1). Changing either side without the other
 * breaks cache invalidation silently.
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
