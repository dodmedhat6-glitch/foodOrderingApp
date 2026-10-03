// Values match the CHECK constraints in migrations/20260418000020_create_orders.ts.

export enum OrderStatus {
    PENDING_PAYMENT = "pending_payment",
    PLACED = "placed",
    ACCEPTED = "accepted",
    REJECTED = "rejected",
    PREPARING = "preparing",
    READY = "ready",
    ASSIGNED = "assigned",
    PICKED = "picked",
    DELIVERED = "delivered",
    CANCELLED = "cancelled",
}

export enum PaymentMethod {
    ONLINE = "online",
    COD = "cod",
}

/**
 * Who is asking for a transition. Derived from the JWT in the controller, not
 * taken from the request, and passed to `assertTransition` — the same target
 * status is legal for one actor and illegal for another (a customer may
 * cancel a `placed` order inside the window; a restaurant may not cancel a
 * `picked` one at all).
 */
export enum OrderActor {
    CUSTOMER = "customer",
    RESTAURANT = "restaurant",
    AGENT = "agent",
    ADMIN = "admin",
    SYSTEM = "system",
}

/** The transition timestamp column stamped when an order enters a status. */
export const STATUS_TIMESTAMP_COLUMN: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.PLACED]: "placed_at",
    [OrderStatus.ACCEPTED]: "accepted_at",
    [OrderStatus.REJECTED]: "rejected_at",
    [OrderStatus.PREPARING]: "preparing_at",
    [OrderStatus.READY]: "ready_at",
    [OrderStatus.ASSIGNED]: "assigned_at",
    [OrderStatus.PICKED]: "picked_at",
    [OrderStatus.DELIVERED]: "delivered_at",
    [OrderStatus.CANCELLED]: "cancelled_at",
};

/** Statuses that require the actor to supply a reason. */
export const STATUSES_REQUIRING_REASON: ReadonlySet<OrderStatus> = new Set([
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
]);

export enum OrderWsEvent {
    CREATED = "order.created",
    STATUS_CHANGED = "order.status_changed",
    CANCELLED = "order.cancelled",
}
