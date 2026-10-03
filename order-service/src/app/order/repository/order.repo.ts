import {Knex} from "knex";
import {OrderEntity} from "../entity/order.entity";
import {OrderStatus} from "../enums";
import {CreateOrderInput, ListOrdersFilters, UpdateOrderStatusInput} from "../types";
import {PaginationParams} from "../../../lib/http/pagination/cursor-pagination";

const ORDER_COLUMNS = [
    "id",
    "region",
    "public_id",
    "country_code",
    "restaurant_id",
    "branch_id",
    "customer_id",
    "customer_address_id",
    "delivery_lat",
    "delivery_lng",
    "delivery_address_text_snapshot",
    "branch_name_snapshot",
    "restaurant_name_snapshot",
    "status",
    "status_reason",
    "subtotal",
    "delivery_fee",
    "service_fee",
    "total",
    "commission",
    "currency",
    "payment_method",
    "delivery_agent_id",
    "created_at",
    "updated_at",
    "placed_at",
    "accepted_at",
    "rejected_at",
    "preparing_at",
    "ready_at",
    "assigned_at",
    "picked_at",
    "delivered_at",
    "cancelled_at",
];

function toEntity(row: any): OrderEntity {
    return new OrderEntity({
        id: Number(row.id),
        region: row.region,
        publicId: row.public_id,
        countryCode: row.country_code,
        restaurantId: Number(row.restaurant_id),
        branchId: Number(row.branch_id),
        customerId: Number(row.customer_id),
        customerAddressId: Number(row.customer_address_id),
        deliveryLat: Number(row.delivery_lat),
        deliveryLng: Number(row.delivery_lng),
        deliveryAddressTextSnapshot: row.delivery_address_text_snapshot,
        branchNameSnapshot: row.branch_name_snapshot,
        restaurantNameSnapshot: row.restaurant_name_snapshot,
        status: row.status as OrderStatus,
        statusReason: row.status_reason,
        subtotal: row.subtotal,
        deliveryFee: row.delivery_fee,
        serviceFee: row.service_fee,
        total: row.total,
        commission: row.commission,
        currency: row.currency,
        paymentMethod: row.payment_method,
        deliveryAgentId: row.delivery_agent_id === null ? null : Number(row.delivery_agent_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        placedAt: row.placed_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        preparingAt: row.preparing_at,
        readyAt: row.ready_at,
        assignedAt: row.assigned_at,
        pickedAt: row.picked_at,
        deliveredAt: row.delivered_at,
        cancelledAt: row.cancelled_at,
    });
}

/**
 * A created_at range used to prune `orders` to as few partitions as possible.
 * Every read that knows roughly when its order was created should carry one —
 * Postgres has no global index across partitions, so without a bound on the
 * partition key a lookup fans out across every month that exists.
 *
 * Bounds are Date objects on purpose: node-postgres converts a Date to a
 * `timestamp without time zone` through the process timezone, the same lens
 * NOW() is stored under, so the comparison lines up with the stored values. An
 * ISO string would be read as a naive local timestamp and silently shift by
 * the UTC offset.
 */
export interface CreatedAtWindow {
    from: Date;
    to: Date;
}

export async function createOrder(data: CreateOrderInput, conn: Knex): Promise<OrderEntity> {
    const now = new Date();
    const [row] = await conn("orders")
        .insert({
            region: data.region,
            public_id: data.publicId,
            country_code: data.countryCode,
            restaurant_id: data.restaurantId,
            branch_id: data.branchId,
            customer_id: data.customerId,
            customer_address_id: data.customerAddressId,
            delivery_lat: data.deliveryLat,
            delivery_lng: data.deliveryLng,
            delivery_address_text_snapshot: data.deliveryAddressTextSnapshot,
            branch_name_snapshot: data.branchNameSnapshot,
            restaurant_name_snapshot: data.restaurantNameSnapshot,
            status: data.status,
            subtotal: data.subtotal,
            delivery_fee: data.deliveryFee,
            service_fee: data.serviceFee,
            total: data.total,
            currency: data.currency,
            payment_method: data.paymentMethod,
            created_at: now,
            updated_at: now,
            placed_at: data.placedAt,
        })
        .returning(ORDER_COLUMNS);

    return toEntity(row);
}

export async function findOrderByPublicId(
    publicId: string,
    conn: Knex,
    window?: CreatedAtWindow,
): Promise<OrderEntity | undefined> {
    const query = conn("orders").select(ORDER_COLUMNS).where("public_id", publicId);
    if (window) {
        query.where("created_at", ">=", window.from).where("created_at", "<", window.to);
    }
    const row = await query.first();
    return row ? toEntity(row) : undefined;
}

/**
 * GET /api/customer/orders — backed by idx_orders_customer_id_created_at.
 * Returns limit + 1 rows so the caller can tell whether another page exists.
 */
export async function findOrdersByCustomer(
    customerId: number,
    params: PaginationParams,
    window: CreatedAtWindow,
    conn: Knex,
): Promise<OrderEntity[]> {
    const query = conn("orders")
        .select(ORDER_COLUMNS)
        .where("customer_id", customerId)
        .where("created_at", ">=", window.from)
        .where("created_at", "<", window.to);

    applyCreatedAtCursor(query, params);

    const rows = await query.orderBy("created_at", params.sortOrder).limit(params.limit + 1);
    return rows.map(toEntity);
}

/**
 * GET /api/restaurant/orders — the hottest read path, backed by
 * idx_orders_branch_status_created_at. That index is why branch_id and status
 * are equality predicates and created_at is the range column.
 */
export async function findOrdersByBranch(
    branchId: number,
    params: PaginationParams,
    filters: ListOrdersFilters,
    conn: Knex,
): Promise<OrderEntity[]> {
    const query = conn("orders").select(ORDER_COLUMNS).where("branch_id", branchId);

    if (filters.status) query.where("status", filters.status);
    if (filters.from) query.where("created_at", ">=", filters.from);
    if (filters.to) query.where("created_at", "<", filters.to);

    applyCreatedAtCursor(query, params);

    const rows = await query.orderBy("created_at", params.sortOrder).limit(params.limit + 1);
    return rows.map(toEntity);
}

/**
 * Status transition. createdAt is in the predicate for two reasons: it is half
 * of the primary key on a partitioned table, and it prunes the update to the
 * one partition the row lives in.
 *
 * The expectedStatus predicate makes this a compare-and-set, so two actors
 * racing the same order can't both win — the loser updates 0 rows, and the
 * service turns that into a 409 instead of silently overwriting a transition
 * that already happened.
 */
export async function updateOrderStatus(
    orderId: number,
    createdAt: Date,
    expectedStatus: OrderStatus,
    data: UpdateOrderStatusInput,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const now = new Date();
    const patch: Record<string, unknown> = {
        status: data.status,
        updated_at: now,
    };
    if (data.statusReason !== undefined) patch.status_reason = data.statusReason;
    if (data.timestampColumn) patch[data.timestampColumn] = now;

    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .where("status", expectedStatus)
        .update(patch)
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

export async function setDeliveryAgent(
    orderId: number,
    createdAt: Date,
    deliveryAgentId: number,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .update({delivery_agent_id: deliveryAgentId, updated_at: new Date()})
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * The cursor is epoch milliseconds (see buildPaginationResultBy) and is
 * converted back to a Date here, so the comparison stays in the same timestamp
 * representation as the stored column.
 */
function applyCreatedAtCursor(query: Knex.QueryBuilder, params: PaginationParams): void {
    if (!params.cursor) return;

    const millis = Number(params.cursor);
    if (!Number.isFinite(millis)) return;

    query.where("created_at", params.sortOrder === "asc" ? ">" : "<", new Date(millis));
}
