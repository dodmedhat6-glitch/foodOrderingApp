import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {branchKey, CORE_BRANCH_TTL_SEC} from "./cache-keys";
import {
    BranchLookup,
    CoreCallContext,
    ReleaseStockResult,
    ReserveStockItem,
    ReserveStockResult,
} from "./types";

/**
 * Branch-shaped reads and the stock write against core's internal surface.
 *
 * Branch metadata is read on every single order placement and changes rarely,
 * so it goes through a read-through Redis cache here *and* a cache on core's
 * side of the call (its lib/cache/cache-keys.ts) — the two are independent and
 * each service runs its own Redis in production. Correctness doesn't rest on
 * either TTL: core publishes `core.branch.invalidated` and the inbound
 * consumer patches or drops the key (lib/core-events/handlers/), so the TTL is
 * only the backstop for a missed event.
 */
export async function getBranch(branchId: number, ctx: CoreCallContext = {}): Promise<BranchLookup> {
    const cached = await readCachedBranch(branchId);
    if (cached) return cached;

    const branch = await coreClient.call<BranchLookup>({
        method: "GET",
        path: `/api/internal/branches/${branchId}`,
        correlationId: ctx.correlationId,
    });

    await cacheBranch(branch);
    return branch;
}

/** The cached branch projection, or null if absent or unreadable. */
export async function readCachedBranch(branchId: number): Promise<BranchLookup | null> {
    const raw = await cacheProvider.get(branchKey(branchId)).catch(() => null);
    if (!raw) return null;

    try {
        return JSON.parse(raw) as BranchLookup;
    } catch {
        // A projection that no longer parses is a miss, not a failure: re-read
        // from core rather than fail the placement waiting on it.
        return null;
    }
}

/**
 * Writes the branch projection. Shared with the core-event handlers so the key
 * and TTL have exactly one definition. Best-effort — a cache write failure
 * must not fail the order.
 */
export async function cacheBranch(branch: BranchLookup): Promise<void> {
    await cacheProvider
        .set(branchKey(branch.id), JSON.stringify(branch), CORE_BRANCH_TTL_SEC)
        .catch(() => {});
}

/**
 * Atomically decrements branch stock for every line, in one core-side
 * transaction. Core returns 409 with the offending lines if any line would
 * underflow, which is the real guard against two customers racing the last
 * unit — our pre-check against the product projection is only there to fail
 * fast with a good message.
 *
 * Called *before* the order rows are written (order.service.placeOrder), so a
 * customer is never told "placed" for units we couldn't hold. The cost of that
 * ordering is that every failure between here and the commit owes the units
 * back — see `releaseStock`.
 *
 * `Idempotency-Key` is forwarded for traceability and so core can dedupe this
 * call if it ever grows an idempotency layer on its internal surface; it has
 * none today, so a retried reserve *does* decrement twice. Our own strict
 * idempotency on `POST /orders` is what prevents that: a replayed request is
 * answered from the recorded response and never reaches this function.
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

/**
 * Returns units a `reserveStock` held for an order that then failed to be
 * written — the compensating call, and the reason reserving first is safe.
 *
 * Core cannot pair this with the original reserve (stock is a single column,
 * there is no reservations ledger), so a double release over-credits stock.
 * It must therefore be called at most once per reserve. The derived
 * idempotency key keeps it distinguishable from the reserve it compensates,
 * which matters the moment core's internal surface does start deduping —
 * sharing the key would make the release look like a replay of the reserve.
 */
export async function releaseStock(
    branchId: number,
    items: ReserveStockItem[],
    ctx: CoreCallContext = {},
): Promise<ReleaseStockResult> {
    return coreClient.call<ReleaseStockResult>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/release-stock`,
        body: {items},
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:release` : undefined,
    });
}
