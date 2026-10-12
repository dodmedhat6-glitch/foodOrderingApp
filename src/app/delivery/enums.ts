/**
 * WebSocket events this module publishes. Values are the wire names clients
 * subscribe to (docs/api-contracts.md s6.4).
 *
 * The order's own lifecycle events stay in `OrderWsEvent` — a claim produces
 * both: `task.assigned` here, and `order.status_changed` from the order
 * module, which is what the customer and the kitchen see.
 */
export enum DeliveryWsEvent {
    /** Sent to every candidate when an order is offered. Carries an expiry. */
    OFFERED = "task.offered",
    /** Sent to the agent who won the claim. */
    ASSIGNED = "task.assigned",
    /** Sent to the candidates who lost it, so their client clears the offer. */
    TAKEN = "task.taken",
    /** Sent when an order an agent holds is cancelled out from under them. */
    CANCELLED = "task.cancelled",
    /** Sent to the admin channel when dispatch gives up on an order. */
    STALLED = "assignment.stalled",
}
