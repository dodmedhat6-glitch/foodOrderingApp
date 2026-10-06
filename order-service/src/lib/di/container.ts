import "reflect-metadata";
import {container} from "tsyringe";
import {TOKENS} from "./tokens";
import {Logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {messageBroker} from "../messaging/init";
import {coreClient} from "../core-client/core-client";
import {CoreProjectionService} from "../core-client/projection.service";
import {OrderStatusService} from "../../app/order/service/order-status.service";
import {OrderService} from "../../app/order/service/order.service";
import {OrderController} from "../../app/order/controller/order.controller";
import {KashierClient} from "../../pkg/payments/kashier/kashier.client";
import {PaymentService} from "../../app/payment/service/payment.service";
import {PaymentWebhookService} from "../../app/payment/service/payment-webhook.service";
import {PaymentController} from "../../app/payment/controller/payment.controller";
import {PaymentWebhookController} from "../../app/payment/controller/webhook.controller";
import {env} from "../config/env";

// Infrastructure
container.registerSingleton<Logger>(TOKENS.Logger, Logger);
container.registerInstance(TOKENS.CacheProvider, cacheProvider);
container.registerInstance(TOKENS.MessageBroker, messageBroker);
container.registerInstance(TOKENS.CoreClient, coreClient);

// Projections of core's data (branches, products, trading flags). Registered
// as infrastructure rather than with the business modules: it owns cache
// shape, not order rules, and its only callers are the inbound core-event
// handlers (lib/core-events/handlers/).
container.registerSingleton<CoreProjectionService>(
    TOKENS.CoreProjectionService,
    CoreProjectionService,
);

// Business modules. This is the one place lib/ is allowed to reference app/
// (CLAUDE.md s3) — registration at boot, nowhere else.
container.registerSingleton<OrderStatusService>(TOKENS.OrderStatusService, OrderStatusService);
container.registerSingleton<OrderService>(TOKENS.OrderService, OrderService);
container.registerSingleton<OrderController>(TOKENS.OrderController, OrderController);

// The acquirer, behind its port. Registered as an instance because the
// adapter takes its credentials in the constructor and holds no app state —
// swapping Kashier for another provider, or for a stub in a local script, is
// this one line (CLAUDE.md s3: pkg/ stays env-free, lib/ supplies the env).
container.registerInstance<KashierClient>(
    TOKENS.PaymentProvider,
    new KashierClient({
        baseUrl: env.payments.kashier.baseUrl,
        merchantId: env.payments.kashier.merchantId,
        apiKey: env.payments.kashier.apiKey,
        secretKey: env.payments.kashier.secretKey,
        maxFailureAttempts: env.payments.kashier.maxFailureAttempts,
        display: env.payments.kashier.display,
        timeoutMs: env.payments.kashier.timeoutMs,
    }),
);

container.registerSingleton<PaymentService>(TOKENS.PaymentService, PaymentService);
container.registerSingleton<PaymentWebhookService>(
    TOKENS.PaymentWebhookService,
    PaymentWebhookService,
);
container.registerSingleton<PaymentController>(TOKENS.PaymentController, PaymentController);
container.registerSingleton<PaymentWebhookController>(
    TOKENS.PaymentWebhookController,
    PaymentWebhookController,
);

export {container};
