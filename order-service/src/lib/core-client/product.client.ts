import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {CORE_PRODUCT_TTL_SEC, productKey} from "./cache-keys";
import {CoreCallContext, ProductLookup} from "./types";

/**
 * Batch price/stock/availability lookup for the lines of one order.
 *
 * Always one HTTP call for the whole basket, never one per line (CLAUDE.md s9.1
 * applies to upstream calls just as much as to SQL). Cached per
 * branch+product on a short TTL and invalidated by core's
 * `product.price.changed` / `product.stock.changed` events; the cached `stock`
 * is a fast-fail hint only — `reserveStock` is what actually holds the units.
 */
export async function getBranchProducts(
    branchId: number,
    productIds: number[],
    ctx: CoreCallContext = {},
): Promise<ProductLookup[]> {
    if (productIds.length === 0) return [];

    const found: ProductLookup[] = [];
    const missing: number[] = [];

    const cached = await Promise.all(
        productIds.map((id) => cacheProvider.get(productKey(branchId, id)).catch(() => null)),
    );
    cached.forEach((value, index) => {
        if (value) found.push(JSON.parse(value) as ProductLookup);
        else missing.push(productIds[index]);
    });

    if (missing.length === 0) return found;

    const fetched = await coreClient.call<ProductLookup[]>({
        method: "GET",
        path: `/api/internal/products?branchId=${branchId}&ids=${missing.join(",")}`,
        correlationId: ctx.correlationId,
    });

    await Promise.all(
        fetched.map((product) =>
            cacheProvider
                .set(productKey(branchId, product.id), JSON.stringify(product), CORE_PRODUCT_TTL_SEC)
                .catch(() => {}),
        ),
    );

    return [...found, ...fetched];
}
