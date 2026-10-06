import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";
import {paymentRouter} from "./app/payment/routes";

export const routes = Router();

routes.use("/health", healthRouter);

// Mounted at the root because the orders module owns three different
// prefixes (/orders, /customer/orders, /restaurant/orders) that all belong to
// the same bounded context.
routes.use("/", orderRouter);

// Mounted at the root for the same reason: the payments module owns
// /payments and /payments/webhook/:provider, and the webhook half must stay
// outside every auth middleware the rest of the tree applies.
routes.use("/", paymentRouter);
// Domain modules register here in later phases:
//   routes.use('/', deliveryRouter);
//   ...
