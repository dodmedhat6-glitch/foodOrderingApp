import {AppError} from "../../lib/error/AppError";
import {logger} from "../../lib/logger/logger";
import {releaseStock, reserveStock} from "../../lib/core-client/branch.client";
import {CoreCallContext, ReserveStockItem} from "../../lib/core-client/types";
import {OutOfStockLine, outOfStockError} from "./errors";

/**
 * Holds and returns stock in core on an order's behalf. Used by placement
 * (reserve, and release when the write fails) and by the unpaid-order
 * cancellation (release).
 */

/**
 * Holds the units this order needs, before any of it is written.
 *
 * Core's locked decrement is the authority on who got the last unit; the
 * pre-check in `priceLines` against the cached product projection only
 * exists to fail fast with a good message, and can be stale by
 * construction. So a 409 here is an ordinary outcome, not an anomaly — and
 * it is translated back into this module's own contract shape
 * (docs/api-contracts.md s1.1) rather than surfacing core's envelope
 * stringified into a message. A customer who loses the race for the last
 * unit gets the same body as one who never had a chance at it.
 */
export async function reserveStockOrFail(
    branchId: number,
    items: ReserveStockItem[],
    ctx: CoreCallContext,
): Promise<void> {
    try {
        await reserveStock(branchId, items, ctx);
    } catch (err) {
        const lines = outOfStockLinesFromCoreError(err);
        if (lines) throw outOfStockError(lines);
        throw err;
    }
}

/**
 * Gives back units a reserve is holding for an order that was never
 * written, or that was cancelled before it was paid.
 *
 * Deliberately swallows its own failure and logs instead: the caller is
 * either already throwing the error the customer will see, or has already
 * committed the cancellation — replacing either with "the release failed"
 * would tell nobody anything they can act on.
 *
 * Both failure branches are logged at `error` because both leak stock —
 * units marked sold that nobody bought. That is an operator problem, not a
 * customer one: it shows up as a branch that has quietly stopped selling a
 * product. `missing` lines are core telling us the product row is gone, so
 * the units had nowhere to return to.
 */
export async function releaseReservedStock(
    branchId: number,
    items: ReserveStockItem[],
    ctx: CoreCallContext,
): Promise<void> {
    try {
        const result = await releaseStock(branchId, items, ctx);
        if (result.missing.length > 0) {
            logger.error("stock release could not return every line", {
                branchId,
                missing: result.missing,
            });
        }
    } catch (err) {
        logger.error("failed to release reserved stock", {
            branchId,
            items,
            correlationId: ctx.correlationId,
            error: (err as Error).message,
        });
    }
}

/**
 * Recovers the offending lines from core's `reserve-stock` 409 so the failure
 * can be re-thrown in this module's own contract shape.
 *
 * `coreUpstreamError` parks core's parsed body on `details.upstream`, and core
 * wraps every reply as `{success, data}` with `AppError.details` merged into
 * `data` — so the lines land at `upstream.data.details`. Returns undefined for
 * anything that isn't recognisably that shape, which is the signal to rethrow
 * the original error untouched rather than mislabel it as a stock problem.
 */
function outOfStockLinesFromCoreError(err: unknown): OutOfStockLine[] | undefined {
    if (!(err instanceof AppError) || err.statusCode !== 409) return undefined;

    const data = (err.details?.upstream as {data?: {message?: string; details?: unknown}} | undefined)?.data;
    if (data?.message !== "OutOfStock" || !Array.isArray(data.details)) return undefined;

    const lines = data.details.filter(
        (line): line is OutOfStockLine =>
            typeof line === "object" &&
            line !== null &&
            typeof (line as OutOfStockLine).productId === "number",
    );
    return lines.length > 0 ? lines : undefined;
}
