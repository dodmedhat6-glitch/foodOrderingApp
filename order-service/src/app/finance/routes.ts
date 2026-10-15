import {Router} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {FinanceController} from "./controller/finance.controller";

export const financeRouter = Router();
const financeController = container.resolve<FinanceController>(TOKENS.FinanceController);

/**
 * Restaurant finance hangs off the restaurant, not a branch: a balance is per
 * `(restaurant, currency)` and a payout goes to the restaurant as a whole.
 * Nested under `/restaurants/:restaurantId` for the same reason every
 * permission-checked route is (CLAUDE.md s4) — `requireRestaurantMember` reads
 * the tenant out of the path. There is no `requireBranchAccess`: a
 * `branch_manager` holds `finance:read` (restaurant-finance.md s5) and sees
 * the restaurant's balance, not a slice of it.
 *
 * Nothing here is cached. Every endpoint is either a money read an owner
 * reconciles against their bank, or a money write.
 */
export const restaurantFinanceRouter = Router({mergeParams: true});

const financeReader = [
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    rbac({resource: "finance", action: "read"}),
];

restaurantFinanceRouter.get("/finance/balance", ...financeReader, financeController.getBalance);
restaurantFinanceRouter.get("/finance/payouts", ...financeReader, financeController.listPayouts);
restaurantFinanceRouter.get("/finance/summary", ...financeReader, financeController.getSummary);

/**
 * Recording a payout is admin-only and strictly idempotent. `requireRole`
 * rather than `rbac({finance:payout_create})`: core seeds that permission for
 * later, but no restaurant role is meant to pay itself, so the honest check is
 * "is this a system admin" (restaurant-finance.md s1).
 */
restaurantFinanceRouter.post(
    "/finance/payouts",
    authenticate,
    requireRegion,
    requireRole(SystemRole.SYSTEM_ADMIN),
    idempotency({strict: true}),
    financeController.recordPayout,
);

financeRouter.use("/restaurants/:restaurantId", restaurantFinanceRouter);
