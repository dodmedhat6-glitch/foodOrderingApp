import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens";
import {logger} from "../logger/logger";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {branchKey, branchRejectingOrdersKey, restaurantSuspendedKey} from "./cache-keys";
import {cacheBranch, readCachedBranch} from "./branch.client";
import {cacheBranchProducts, readCachedBranchProduct} from "./product.client";
import {
    BranchLookup,
    BranchProjectionPatch,
    ProductLookup,
    ProductProjectionPatch,
} from "./types";

/**
 * Owns what this service believes about core's data: the Redis projections of
 * branches, products and the trading flags derived from them.
 *
 * This is the service layer behind the inbound core-event handlers
 * (lib/core-events/handlers/). The handlers are thin — parse the envelope,
 * call one method here — for the same reason controllers are thin: the next
 * event that needs a database write, a second upstream call, or a WebSocket
 * broadcast should be a change to a service, not a handler growing a body.
 *
 * Patch, don't drop, wherever the payload allows it
 * -------------------------------------------------
 * Core's events carry the values its writing transaction just committed (its
 * lib/events/events.ts, `buildBranchInvalidationPayload` /
 * `buildProductInvalidationPayload`). When the fields we need are all present,
 * the projection is corrected in place; the next order placement then reads
 * Redis instead of paying an HTTP round trip to core. When they aren't — an
 * older core, a coarse event, a field we can't overwrite wholesale — the
 * projection is deleted and the next placement re-reads it. Both outcomes are
 * correct; one is a cache hit and the other is a cache miss.
 *
 * Two rules keep the patch path honest:
 *
 *  1. **Never create a projection from a patch.** A patch is merged into what
 *     is already cached; if nothing is cached there is nothing to correct, and
 *     inventing a partial projection would mean serving a branch row with
 *     fields core never sent. The methods no-op in that case.
 *  2. **Only patch fields the event actually carries.** `definedOnly` on
 *     core's side strips undefined fields before the payload is persisted, so
 *     a field's presence here means core wrote that value.
 *
 * Every method is idempotent, which is what makes the consumer's
 * at-least-once delivery and its 24h dedupe window safe rather than merely
 * convenient.
 */
@injectable()
export class CoreProjectionService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    /**
     * A branch changed. Patches the cached branch projection with whatever
     * trading flags the event carried, and re-derives the reject-new-orders
     * flag from them.
     *
     * That flag is the reason this is worth patching rather than deleting.
     * `order.service.assertBranchAcceptsOrders` checks it before it even reads
     * the branch projection, so a branch core has just closed stops taking
     * orders on the strength of the event itself — not when a TTL lapses and
     * not after one more round trip. Before core carried the flags in the
     * payload there was no way to set it, and the check was dead code waiting
     * for an event that never came.
     */
    applyBranchChange = async (branchId: number, patch: BranchProjectionPatch): Promise<void> => {
        const flags = definedFields(patch);

        if (flags.length === 0) {
            await this.cache.del(branchKey(branchId)).catch(() => {});
            logger.info("core-projection: branch dropped (payload carried no flags)", {branchId});
            return;
        }

        await this.syncBranchRejectingFlag(branchId, patch);

        const cached = await readCachedBranch(branchId);
        if (!cached) {
            // Nothing to correct. Rule 1: a patch never creates a projection.
            logger.info("core-projection: branch not cached, nothing to patch", {branchId});
            return;
        }

        await cacheBranch(mergeDefined<BranchLookup>(cached, patch));
        logger.info("core-projection: branch patched", {branchId, fields: flags});
    };

    /**
     * A restaurant changed. Its trading status reaches us only *inside* the
     * branch projection (core joins it into the branch lookup), and the event
     * doesn't name the status, so there is nothing to patch: every branch
     * projection goes and the next placement re-reads one.
     *
     * A pattern delete is unavoidable here — the event names the restaurant,
     * and the keys are per branch. It is a cursor scan with UNLINK
     * (pkg/cache/redis.ts), so it does not block the request path.
     */
    invalidateRestaurant = async (restaurantId: number): Promise<void> => {
        const deleted = await this.cache.delByPattern("core:branch:*").catch(() => 0);
        await this.cache.del(restaurantSuspendedKey(restaurantId)).catch(() => {});
        logger.info("core-projection: restaurant invalidated", {
            restaurantId,
            branchKeysDeleted: deleted,
        });
    };

    /**
     * A branch product changed — price, stock or availability.
     *
     * This is the hot one: stock moves on every order placed anywhere, so
     * every placement publishes one of these per line. Dropping the projection
     * each time would mean the *next* basket containing that product pays an
     * HTTP round trip to core, which in a busy branch is close to every
     * basket. Patching keeps the cache warm through exactly the event that
     * would otherwise keep flushing it.
     *
     * Without a `branchId` the event can't be localised — the projection is
     * keyed per branch+product — so it degrades to dropping that product from
     * every branch that cached it.
     */
    applyProductChange = async (
        productId: number,
        patch: ProductProjectionPatch,
    ): Promise<void> => {
        const {branchId, ...fields} = patch;
        const changed = definedFields(fields);

        if (branchId === undefined || changed.length === 0) {
            const deleted = await this.cache
                .delByPattern(`core:product:*:${productId}`)
                .catch(() => 0);
            logger.info("core-projection: product dropped from every branch", {
                productId,
                keysDeleted: deleted,
                reason: branchId === undefined ? "no branchId in payload" : "no patchable fields",
            });
            return;
        }

        const cached = await readCachedBranchProduct(branchId, productId);
        if (!cached) {
            logger.info("core-projection: product not cached, nothing to patch", {
                productId,
                branchId,
            });
            return;
        }

        await cacheBranchProducts(branchId, [mergeDefined<ProductLookup>(cached, fields)]);
        logger.info("core-projection: product patched", {productId, branchId, fields: changed});
    };

    /**
     * Mirrors the branch's trading flags into the standalone
     * reject-new-orders key, so order placement can refuse without reading the
     * branch projection at all.
     *
     * Only acted on when the event says something definite: a payload that
     * carries neither flag leaves the flag alone rather than guessing a branch
     * back open. The flag has no TTL — it is cleared by the event that reopens
     * the branch, because an expiring "closed" flag would quietly start
     * accepting orders again.
     */
    private syncBranchRejectingFlag = async (
        branchId: number,
        patch: BranchProjectionPatch,
    ): Promise<void> => {
        const closed = patch.isActive === false || patch.acceptOrders === false;
        const open = patch.isActive !== false && patch.acceptOrders !== false;

        try {
            if (closed) await this.cache.set(branchRejectingOrdersKey(branchId), "1");
            else if (open) await this.cache.del(branchRejectingOrdersKey(branchId));
        } catch (err) {
            // Loud: a branch that core has closed is still taking orders until
            // its projection is re-read, which is a money-affecting window.
            logger.error("core-projection: failed to sync branch rejecting flag", {
                branchId,
                closed,
                error: (err as Error).message,
            });
        }
    };
}

function definedFields(fields: object): string[] {
    return Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
}

/**
 * Merges a patch into a projection, ignoring keys whose value is undefined.
 *
 * Not `{...cached, ...patch}`: the patch objects are built by the handlers'
 * payload parsers, which return every optional field as an explicit key — so a
 * field the event didn't carry is *present and undefined*, and a plain spread
 * overwrites the cached value with undefined. That silently erased the price
 * from a projection whose event only reported stock.
 */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
    const merged = {...base};
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return merged;
}
