export type CoreEventHandler = (payload: unknown) => Promise<void>;

export interface CoreEventEnvelope {
    eventId: string;
    eventType: string;
    occurredAt: string;
    payload: unknown;
}

/**
 * Payload shape shared by every `core.<entity>.invalidated` event — core's
 * `buildInvalidationPayload` in its lib/events/events.ts. Hand-maintained
 * contract: core has no compile-time view of this file.
 */
export interface CoreInvalidationPayload {
    id: number;
    occurredAt: string;
}
