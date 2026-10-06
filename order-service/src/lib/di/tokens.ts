export const TOKENS = {
    // infra
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    CoreProjectionService: Symbol.for("CoreProjectionService"),
    WsServer: Symbol.for("WsServer"),

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
};
