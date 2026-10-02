import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";

export const routes = Router();

routes.use("/health", healthRouter);

// Mounted at the root because the orders module owns three different
// prefixes (/orders, /customer/orders, /restaurant/orders) that all belong to
// the same bounded context.
routes.use("/", orderRouter);
// Domain modules register here in later phases:
//   routes.use('/payments', paymentRouter);
//   ...
