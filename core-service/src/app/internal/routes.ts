import { Router } from "express";
import { apiKeyAuth } from "../../lib/auth/api-key.guard";
import { rbac } from "../../lib/auth/rbac";
import { container } from "../../lib/di/containers";
import { tokens } from "../../lib/di/tokens";
import { InternalController } from "./controller/internal.controller";

/**
 * Service-to-service surface for order-service (and any future internal
 * caller). Every route requires a valid API key (see lib/auth/api-key.guard.ts)
 * plus the `read` permission on the matching resource, seeded onto the
 * `order_service` role in migrations/20260927100300_seed_order_service_permissions.ts.
 * Never mount anything here behind the human-facing `authenticate` guard.
 */
export const internalRouter = Router();
const internalController = container.resolve<InternalController>(tokens.InternalController);

internalRouter.get(
    "/branches/:branchId",
    apiKeyAuth,
    rbac({ resource: "core:branch", action: "read" }),
    internalController.getBranch
);

internalRouter.get(
    "/addresses/:addressId",
    apiKeyAuth,
    rbac({ resource: "core:address", action: "read" }),
    internalController.getAddress
);

internalRouter.get(
    "/users/:userId",
    apiKeyAuth,
    rbac({ resource: "core:user", action: "read" }),
    internalController.getUser
);

internalRouter.get(
    "/products",
    apiKeyAuth,
    rbac({ resource: "core:product", action: "read" }),
    internalController.getProducts
);

// Write surface: holds the units an order-service order has committed to.
// `reserve` rather than `update` so the order_service role can decrement stock
// without being able to edit products at large
// (migrations/20261002090000_seed_product_reserve_permission.ts).
internalRouter.post(
    "/branches/:branchId/reserve-stock",
    apiKeyAuth,
    rbac({ resource: "core:product", action: "reserve" }),
    internalController.reserveStock
);
