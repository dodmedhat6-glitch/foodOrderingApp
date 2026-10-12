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
import {OrderPlacementService} from "../../app/order/service/order-placement.service";
import {OrderDispatchService} from "../../app/order/service/order-dispatch.service";
import {OrderNotifier} from "../../app/order/service/order-notifier.service";
import {OrderController} from "../../app/order/controller/order.controller";
import {KashierClient} from "../../pkg/payments/kashier/kashier.client";
import {PaymentService} from "../../app/payment/service/payment.service";
import {PaymentWebhookService} from "../../app/payment/service/payment-webhook.service";
import {PaymentController} from "../../app/payment/controller/payment.controller";
import {PaymentWebhookController} from "../../app/payment/controller/webhook.controller";
import {RedisPresenceStore} from "../../pkg/presence/redis-presence.store";
import {redisClient} from "../cache/init";
import {PresenceService} from "../../app/agent/service/presence.service";
import {AgentService} from "../../app/agent/service/agent.service";
import {AgentController} from "../../app/agent/controller/agent.controller";
import {AssignmentService} from "../../app/delivery/service/assignment.service";
import {DeliveryService} from "../../app/delivery/service/delivery.service";
import {DeliveryController} from "../../app/delivery/controller/delivery.controller";
import {LedgerService} from "../../app/payment/service/ledger.service";
import {FinanceService} from "../../app/finance/service/finance.service";
import {FinanceController} from "../../app/finance/controller/finance.controller";
import {ArchivalService} from "../../app/archival/service/archival.service";
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
container.registerSingleton<OrderNotifier>(TOKENS.OrderNotifier, OrderNotifier);
container.registerSingleton<OrderService>(TOKENS.OrderService, OrderService);
container.registerSingleton<OrderPlacementService>(TOKENS.OrderPlacementService, OrderPlacementService);
container.registerSingleton<OrderDispatchService>(TOKENS.OrderDispatchService, OrderDispatchService);
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
container.registerSingleton<LedgerService>(TOKENS.LedgerService, LedgerService);
container.registerSingleton<PaymentWebhookService>(
    TOKENS.PaymentWebhookService,
    PaymentWebhookService,
);
container.registerSingleton<PaymentController>(TOKENS.PaymentController, PaymentController);
container.registerSingleton<PaymentWebhookController>(
    TOKENS.PaymentWebhookController,
    PaymentWebhookController,
);

// Live agent location, behind its port. An instance rather than a singleton
// class for the same reason as the acquirer above: the adapter takes its
// configuration in the constructor and pkg/ stays env-free, so lib/ supplies
// the Redis connection and the TTL here.
//
// That TTL is the five-minute freshness rule (docs/database-design.md s3.8).
// It is not a cache expiry with a business meaning bolted on — it is the only
// place the rule exists, which is why nothing downstream compares timestamps.
container.registerInstance<RedisPresenceStore>(
    TOKENS.PresenceStore,
    new RedisPresenceStore(redisClient, env.presence.staleSec),
);

// Delivery + agents. One phase, two bounded contexts: `app/agent/` never
// writes an order, `app/delivery/` never writes presence.
container.registerSingleton<PresenceService>(TOKENS.PresenceService, PresenceService);
container.registerSingleton<AgentService>(TOKENS.AgentService, AgentService);
container.registerSingleton<AssignmentService>(TOKENS.AssignmentService, AssignmentService);
container.registerSingleton<DeliveryService>(TOKENS.DeliveryService, DeliveryService);
container.registerSingleton<AgentController>(TOKENS.AgentController, AgentController);
container.registerSingleton<DeliveryController>(TOKENS.DeliveryController, DeliveryController);

// Restaurant finance: the running balance settlement credits, the payouts
// that debit it, and the ledger summary behind both.
container.registerSingleton<FinanceService>(TOKENS.FinanceService, FinanceService);
container.registerSingleton<FinanceController>(TOKENS.FinanceController, FinanceController);

// Archival: moves prior-year rows to the archive cluster. Runs in the worker
// process only (app/archival/jobs.ts); the API never calls it.
container.registerSingleton<ArchivalService>(TOKENS.ArchivalService, ArchivalService);

export {container};
