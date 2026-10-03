import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {branchKey, CORE_BRANCH_TTL_SEC} from "./cache-keys";
import {BranchLookup, CoreCallContext, ReserveStockItem, ReserveStockResult} from "./types";

/**
 * Branch-shaped reads against core's internal surface.
 *
 * Branch metadata is read on every single order placement and changes rarely,
 * so it goes through a read-through Redis cache. Correctness doesn't rest on
 * the TTL: core publishes `branch.updated` / `branch.deactivated` and the
 * inbound consumer deletes the key (lib/core-events/handlers.ts), so the TTL is
 * only the backstop for a missed event.
 */
export async function getBranch(branchId: number, ctx: CoreCallContext = {}): Promise<BranchLookup> {
    const key = branchKey(branchId);

    const cached = await cacheProvider.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as BranchLookup;

    const branch = await coreClient.call<BranchLookup>({
        method: "GET",
        path: `/api/internal/branches/${branchId}`,
        correlationId: ctx.correlationId,
    });

    // A cache write failure must not fail the order.
    await cacheProvider.set(key, JSON.stringify(branch), CORE_BRANCH_TTL_SEC).catch(() => {});
    return branch;
}

/**
 * Atomically decrements branch stock for every line, in one core-side
 * transaction. Core returns 409 with the offending lines if any line would
 * underflow, which is the real guard against two customers racing the last
 * unit — our pre-check against the product projection is only there to fail
 * fast with a good message.
 *
 * Idempotent on core's side via the forwarded `Idempotency-Key`, so a retry
 * after a timeout cannot double-decrement.
 */
export async function reserveStock(
    branchId: number,
    items: ReserveStockItem[],
    ctx: CoreCallContext = {},
): Promise<ReserveStockResult> {
    return coreClient.call<ReserveStockResult>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/reserve-stock`,
        body: {items},
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey,
    });
}
