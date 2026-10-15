import {Knex} from "knex";
import {OrderItemEntity} from "../entity/order-item.entity";
import {CreateOrderItemInput, OrderItemCount} from "../types";

const ORDER_ITEM_COLUMNS = [
    "id",
    "region",
    "order_id",
    "product_id",
    "quantity",
    "unit_price_snapshot",
    "name_snapshot",
    "image_url_snapshot",
    "line_total",
    "created_at",
];

function toEntity(row: any): OrderItemEntity {
    return new OrderItemEntity({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        productId: Number(row.product_id),
        quantity: row.quantity,
        unitPriceSnapshot: row.unit_price_snapshot,
        nameSnapshot: row.name_snapshot,
        imageUrlSnapshot: row.image_url_snapshot,
        lineTotal: row.line_total,
        createdAt: row.created_at,
    });
}

/** One multi-row INSERT for the whole basket, never a loop over lines. */
export async function bulkInsertItems(
    orderId: number,
    items: CreateOrderItemInput[],
    conn: Knex,
): Promise<OrderItemEntity[]> {
    if (items.length === 0) return [];

    const now = new Date();
    const rows = await conn("order_items")
        .insert(
            items.map((item) => ({
                region: item.region,
                order_id: orderId,
                product_id: item.productId,
                quantity: item.quantity,
                unit_price_snapshot: item.unitPriceSnapshot,
                name_snapshot: item.nameSnapshot,
                image_url_snapshot: item.imageUrlSnapshot,
                line_total: item.lineTotal,
                created_at: now,
            })),
        )
        .returning(ORDER_ITEM_COLUMNS);

    return rows.map(toEntity);
}

/**
 * Batch fetch for every list and detail read. The whereIn is the whole point:
 * a caller that mapped over orders and asked for one order's items at a time
 * would be the N+1 that CLAUDE.md s9.1 forbids, so there is deliberately no
 * findItemsByOrderId(single) to reach for.
 */
export async function findItemsByOrderIds(
    orderIds: number[],
    conn: Knex,
): Promise<OrderItemEntity[]> {
    if (orderIds.length === 0) return [];

    const rows = await conn("order_items")
        .select(ORDER_ITEM_COLUMNS)
        .whereIn("order_id", orderIds)
        .orderBy("id", "asc");

    return rows.map(toEntity);
}

/**
 * Line counts only, for list responses that show "3 items" without needing the
 * lines themselves — one grouped query instead of hydrating every item row.
 */
export async function countItemsByOrderIds(
    orderIds: number[],
    conn: Knex,
): Promise<OrderItemCount[]> {
    if (orderIds.length === 0) return [];

    const rows = await conn("order_items")
        .select("order_id")
        .count<{order_id: string; count: string}[]>("id as count")
        .whereIn("order_id", orderIds)
        .groupBy("order_id");

    return rows.map((row) => ({orderId: Number(row.order_id), count: Number(row.count)}));
}
