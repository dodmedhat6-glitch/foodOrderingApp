export const TOKENS = {
    // infra
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    CoreProjectionService: Symbol.for("CoreProjectionService"),
    WsServer: Symbol.for("WsServer"),
    // Live agent location. A pkg/ port like PaymentProvider, not a cache: it
    // is the only copy of presence there is (docs/database-design.md s3.8).
    PresenceStore: Symbol.for("PresenceStore"),

    // orders
    OrderService: Symbol.for("OrderService"),
    OrderStatusService: Symbol.for("OrderStatusService"),
    OrderController: Symbol.for("OrderController"),

    // payments
    PaymentProvider: Symbol.for("PaymentProvider"),
    PaymentService: Symbol.for("PaymentService"),
    PaymentWebhookService: Symbol.for("PaymentWebhookService"),
    PaymentController: Symbol.for("PaymentController"),
    PaymentWebhookController: Symbol.for("PaymentWebhookController"),

    // delivery + agents (one phase, two bounded contexts)
    PresenceService: Symbol.for("PresenceService"),
    AgentService: Symbol.for("AgentService"),
    AgentController: Symbol.for("AgentController"),
    AssignmentService: Symbol.for("AssignmentService"),
    DeliveryService: Symbol.for("DeliveryService"),
    DeliveryController: Symbol.for("DeliveryController"),

    // restaurant finance — the balance half only in this phase; the read
    // endpoints and payouts arrive in Phase 4.
    FinanceService: Symbol.for("FinanceService"),
};
