/**
 * The routing keys this service publishes on the `order.events` topic
 * exchange, which are also its event types.
 *
 * Nothing here publishes. A caller enqueues an outbox row in the same
 * transaction as the domain write (outbox.repo.ts `enqueueOutboxEvent`);
 * the worker drains it (outbox-drain.ts). Consumers bind `order.#` — `#`
 * rather than `*` so that a later three-segment key is not silently dropped.
 *
 * The contract a consumer relies on is the envelope (types.ts
 * `OutboundEventEnvelope`) plus each event's payload type. Changing either
 * on this side alone breaks the consumer silently — analytics-service parses
 * these by hand.
 */
export const OrderEventType = {
    /**
     * An order became `placed`: the kitchen can see it. For COD that is the
     * placement itself; for an online order it is the payment capture, never
     * the creation of the `pending_payment` row — an order nobody paid for is
     * not an order to anyone downstream.
     */
    ORDER_PLACED: "order.placed",
} as const;

/** `entity_type` on the outbox row and in the envelope. */
export const ORDER_ENTITY_TYPE = "order";
