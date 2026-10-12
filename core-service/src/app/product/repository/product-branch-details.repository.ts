import {Knex} from "knex";
import {db} from "../../../lib/knex/kenx";
import {ProductBranchDetails} from "../entity/product-branch-details.entity";

const PBD_COLUMNS = ['id', 'branch_id', 'product_id', 'price', 'stock', 'is_available'];

function toEntity(row: any): ProductBranchDetails {
    return new ProductBranchDetails({
        id: row.id,
        branchId: row.branch_id,
        productId: row.product_id,
        price: row.price,
        stock: row.stock,
        isAvailable: row.is_available,
    });
}

export async function updateBranchDetails(branchId: number, productId: number, data: {price?: number, stock?: number, isAvailable?: boolean}, conn: Knex = db): Promise<ProductBranchDetails> {
    const [row] = await conn("product_branch_details")
        .where("branch_id", branchId)
        .where("product_id", productId)
        .update({
            price: data.price,
            stock: data.stock,
            is_available: data.isAvailable,
        })
        .returning(PBD_COLUMNS);
    return toEntity(row);
}

export interface ReserveStockLine {
    productId: number;
    quantity: number;
}

export interface ReservedLine {
    productId: number;
    quantity: number;
    remainingStock: number;
}

export interface UnavailableLine {
    productId: number;
    requested: number;
    available: number;
}

/**
 * Atomically decrements branch stock for a whole basket, or changes nothing.
 *
 * Called by order-service once it has committed an order (see its
 * order.service.placeOrder -> reserveStockOrVoid): this is the authority on
 * who got the last unit, so it has to be a real lock rather than a
 * read-then-write. The rows are locked FOR UPDATE in ascending product_id
 * order, which is what stops two concurrent baskets that overlap on two
 * products from deadlocking each other.
 *
 * Returns the offending lines instead of throwing, so the caller can answer
 * with the whole list and let the customer fix their basket in one pass. A
 * product the branch doesn't carry, has turned off, or can't cover all land in
 * `unavailable` - from the customer's side they mean the same thing.
 */
export async function reserveBranchStock(
    branchId: number,
    lines: ReserveStockLine[],
    conn: Knex
): Promise<{ reserved: ReservedLine[]; unavailable: UnavailableLine[] }> {
    if (lines.length === 0) {
        return { reserved: [], unavailable: [] };
    }

    const requestedByProduct = new Map<number, number>();
    for (const line of lines) {
        requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0) + line.quantity);
    }
    const productIds = [...requestedByProduct.keys()].sort((a, b) => a - b);

    const rows = await conn("product_branch_details")
        .select(PBD_COLUMNS)
        .where("branch_id", branchId)
        .whereIn("product_id", productIds)
        .orderBy("product_id", "asc")
        .forUpdate();

    const rowByProduct = new Map<number, any>(rows.map((row: any) => [Number(row.product_id), row]));

    const unavailable: UnavailableLine[] = [];
    for (const productId of productIds) {
        const requested = requestedByProduct.get(productId)!;
        const row = rowByProduct.get(productId);
        if (!row || !row.is_available || row.stock < requested) {
            unavailable.push({ productId, requested, available: row ? row.stock : 0 });
        }
    }

    if (unavailable.length > 0) {
        return { reserved: [], unavailable };
    }

    const reserved: ReservedLine[] = [];
    for (const productId of productIds) {
        const requested = requestedByProduct.get(productId)!;
        const [row] = await conn("product_branch_details")
            .where("branch_id", branchId)
            .where("product_id", productId)
            .decrement("stock", requested)
            .returning(PBD_COLUMNS);

        reserved.push({ productId, quantity: requested, remainingStock: row.stock });
    }

    return { reserved, unavailable };
}

export interface MissingLine {
    productId: number;
    quantity: number;
}

/**
 * Gives back units a `reserveBranchStock` held - the compensation
 * order-service runs when an order that already reserved is never written,
 * or is rejected/cancelled before delivery.
 *
 * Same lock discipline as the reserve (FOR UPDATE, ascending product_id), so a
 * release and a reserve that overlap on two products can't deadlock each
 * other.
 *
 * Never fails on a vanished row: the caller is already compensating something
 * and has nothing useful to do with a second error. A product whose branch row
 * is gone is reported in `missing` instead - the units had nowhere to return
 * to, which is worth logging but not worth failing over. `is_available` is
 * deliberately not checked: a product switched off since the reserve still
 * owns the stock it was holding.
 */
export async function releaseBranchStock(
    branchId: number,
    lines: ReserveStockLine[],
    conn: Knex
): Promise<{ released: ReservedLine[]; missing: MissingLine[] }> {
    if (lines.length === 0) {
        return { released: [], missing: [] };
    }

    const quantityByProduct = new Map<number, number>();
    for (const line of lines) {
        quantityByProduct.set(line.productId, (quantityByProduct.get(line.productId) ?? 0) + line.quantity);
    }
    const productIds = [...quantityByProduct.keys()].sort((a, b) => a - b);

    const rows = await conn("product_branch_details")
        .select("product_id")
        .where("branch_id", branchId)
        .whereIn("product_id", productIds)
        .orderBy("product_id", "asc")
        .forUpdate();
    const present = new Set<number>(rows.map((row: any) => Number(row.product_id)));

    const released: ReservedLine[] = [];
    const missing: MissingLine[] = [];
    for (const productId of productIds) {
        const quantity = quantityByProduct.get(productId)!;
        if (!present.has(productId)) {
            missing.push({ productId, quantity });
            continue;
        }

        const [row] = await conn("product_branch_details")
            .where("branch_id", branchId)
            .where("product_id", productId)
            .increment("stock", quantity)
            .returning(PBD_COLUMNS);

        released.push({ productId, quantity, remainingStock: row.stock });
    }

    return { released, missing };
}
