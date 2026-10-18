import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {CORE_PRODUCT_TTL_SEC, productKey} from "./cache-keys";
import {CoreCallContext, ProductLookup} from "./types";

/**
 * Batch price/stock/availability lookup for the lines of one order.
 *
 * Two batching rules, and the whole shape of this file follows from them:
 *
 *  - One HTTP call for the whole basket, never one per line (CLAUDE.md s9.1
 *    applies to upstream calls as much as to SQL).
 *  - One Redis round trip for the whole basket. The projection is keyed per
 *    branch+product rather than per basket, because that is the granularity
 *    core's invalidation events arrive at and the granularity two overlapping
 *    baskets share — but N sequential GETs would pay N network latencies and
 *    hand the win back. MGET is what makes the granular key the right call.
 *
 * The cached `stock` is a fast-fail hint only; `reserveStock` is what actually
 * holds the units.
 */
export async function getBranchProducts(
    branchId: number,
    productIds: number[],
    ctx: CoreCallContext = {},
): Promise<ProductLookup[]> {
    if (productIds.length === 0) return [];

    const keys = productIds.map((id) => productKey(branchId, id));
    const cached = await cacheProvider.getMany(keys).catch(() => keys.map(() => null));

    const found: ProductLookup[] = [];
    const missing: number[] = [];
    cached.forEach((value, index) => {
        const parsed = value ? parseProjection(value) : null;
        if (parsed) found.push(parsed);
        else missing.push(productIds[index]);
    });

    if (missing.length === 0) return found;

    const fetched = await coreClient.call<ProductLookup[]>({
        method: "GET",
        path: `/api/internal/products?branchId=${branchId}&ids=${missing.join(",")}`,
        correlationId: ctx.correlationId,
    });

    await cacheBranchProducts(branchId, fetched);
    return [...found, ...fetched];
}

/**
 * Writes a batch of product projections. Shared with the core-event handlers,
 * which repopulate a projection from an event payload — the TTL and the key
 * shape must not differ between the two writers.
 *
 * Best-effort: a cache write failure must never fail the order placement that
 * triggered the read.
 */
export async function cacheBranchProducts(
    branchId: number,
    products: ProductLookup[],
): Promise<void> {
    if (products.length === 0) return;

    await cacheProvider
        .setMany(
            products.map((product) => ({
                key: productKey(branchId, product.id),
                value: JSON.stringify(product),
            })),
            CORE_PRODUCT_TTL_SEC,
        )
        .catch(() => {});
}

/**
 * The cached projection for one branch+product, or null if it isn't cached (or
 * is unreadable).
 *
 * Exists for the event handlers' patch path: patching requires knowing what is
 * already there, and a product event that finds nothing cached must do nothing
 * rather than populate from a partial payload.
 */
export async function readCachedBranchProduct(
    branchId: number,
    productId: number,
): Promise<ProductLookup | null> {
    const raw = await cacheProvider.get(productKey(branchId, productId)).catch(() => null);
    return raw ? parseProjection(raw) : null;
}

/**
 * A projection that no longer parses is treated as a miss, not an error: the
 * shape could have changed under a deploy, and the correct answer is to
 * re-read from core rather than fail the request.
 */
function parseProjection(raw: string): ProductLookup | null {
    try {
        return JSON.parse(raw) as ProductLookup;
    } catch {
        return null;
    }
}
