import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";
import {paymentRouter} from "./app/payment/routes";
import {deliveryRouter} from "./app/delivery/routes";
import {agentRouter} from "./app/agent/routes";

export const routes = Router();

routes.use("/health", healthRouter);

// Mounted at the root because the orders module owns several prefixes that all
// belong to the same bounded context: the caller-scoped /orders and
// /customer/orders, and the tenant-scoped
// /restaurants/:restaurantId/branches/:branchId/orders where the RBAC
// middleware can read the tenancy out of the path.
routes.use("/", orderRouter);

// Mounted at the root for the same reason: the payments module owns
// /payments, /payments/webhook/:provider and its own branch-scoped read under
// /restaurants/:restaurantId/branches/:branchId. The webhook half must stay
// outside every auth middleware the rest of the tree applies.
//
// Both modules declare a sub-router under the same tenant prefix, which is
// fine: a sub-router that matches no route inside itself calls next(), so the
// request falls through to the next one mounted here.
routes.use("/", paymentRouter);

// Dispatch hangs off /orders/:orderId (claim, unclaim, admin assign) because a
// delivery is a phase of an order, not a resource beside it.
routes.use("/", deliveryRouter);

// The agent's own surface: /agents/presence/*, /agents/tasks, /agents/earnings.
routes.use("/", agentRouter);
