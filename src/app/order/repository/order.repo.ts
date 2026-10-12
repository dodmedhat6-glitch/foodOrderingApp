import {Knex} from "knex";
import {OrderEntity} from "../entity/order.entity";
import {OrderStatus} from "../enums";
import {
    AgentOrderFilters,
    CreateOrderInput,
    ListOrdersFilters,
    OrderScope,
    UpdateOrderStatusInput,
} from "../types";
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

/**
 * What an agent's task list shows when no status filter is given: the work in
 * front of them, not their history. Delivered orders are reachable by asking
 * for them explicitly, and the month's earnings are a different endpoint.
 *
 * `preparing` and `ready` are here because dispatch starts in the kitchen: an
 * agent can claim an order while it is still `preparing`, and is then holding
 * it — driving to the branch — before it is `assigned`. `ready` with an agent
 * attached is only ever transient (the `ready` write promotes it to `assigned`
 * in the same transaction), but listing it costs nothing and means a crash
 * between the two can never hide an order from the agent who holds it.
 */
const ACTIVE_AGENT_STATUSES = [
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.ASSIGNED,
    OrderStatus.PICKED,
];

/** Where an order sits while dispatch is looking for an agent for it. */
const DISPATCHABLE_STATUSES = [OrderStatus.PREPARING, OrderStatus.READY];

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

/**
 * One order by its public id, optionally narrowed to a branch.
 *
 * `scope` is how the restaurant-facing endpoints keep their tenancy in the
 * query instead of beside it: on
 * `/restaurants/:restaurantId/branches/:branchId/orders/:orderId` the lookup
 * filters on all three ids, so an order id from a neighbouring branch matches
 * no row. Callers with no HTTP caller to scope — the payment webhook, the
 * expiry sweep — pass none.
 *
 * The extra predicates need no index of their own. `public_id` is already
 * unique within a partition, so they are evaluated against the single row the
 * index produced.
 */
export async function findOrderByPublicId(
    publicId: string,
    conn: Knex,
    window?: CreatedAtWindow,
    scope?: OrderScope,
): Promise<OrderEntity | undefined> {
    const query = conn("orders").select(ORDER_COLUMNS).where("public_id", publicId);
    if (window) {
        query.where("created_at", ">=", window.from).where("created_at", "<", window.to);
    }
    applyScope(query, scope);

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
 * GET /api/restaurants/{restaurantId}/branches/{branchId}/orders — the
 * hottest read path, backed by idx_orders_branch_status_created_at. That index
 * is why branch_id and status are equality predicates and created_at is the
 * range column.
 *
 * `restaurant_id` is in the predicate as well, and deliberately *after*
 * branch_id in the index's terms rather than added to the index: a branch
 * belongs to exactly one restaurant, so the column is redundant for selectivity
 * and indexing it would buy nothing (CLAUDE.md s7 — no speculative indexes).
 * What it buys is that the query cannot return another restaurant's rows even
 * if a branch id from the path were ever wrong.
 */
export async function findOrdersByBranch(
    scope: OrderScope,
    params: PaginationParams,
    filters: ListOrdersFilters,
    conn: Knex,
): Promise<OrderEntity[]> {
    const query = conn("orders").select(ORDER_COLUMNS);
    applyScope(query, scope);

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
    // Settlement stamps the commission in the same UPDATE that moves the
    // order to `delivered`, so the money and the status can never disagree
    // about whether a delivery was settled.
    if (data.commission !== undefined) patch.commission = data.commission;

    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .where("status", expectedStatus)
        .update(patch)
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * The claim. **This is the arbiter of the dispatch race**, and the reason
 * there is no lock, no Redis reservation and no `deliveries` row holding a
 * pending offer anywhere in this service.
 *
 * An order is offered to several agents at once; they all race here. The
 * `status IN ('preparing','ready') AND delivery_agent_id IS NULL` predicate
 * means exactly one UPDATE can match — Postgres serialises the row and the
 * losers see the already-written values. Zero rows affected is therefore not
 * an error condition to retry, it is the answer: somebody else won.
 *
 * Claimable from `preparing` because dispatch starts in the kitchen, so the
 * agent is driving while the food cooks. Such a claim attaches the agent and
 * leaves the status alone — the order is not `assigned` until it is also
 * `ready`, and `picked` stays reachable only from `assigned`. The `ready`
 * write promotes it (`promoteClaimedReadyOrder`).
 *
 * The status is a CASE on the row as Postgres sees it at write time, not on
 * what the caller read, so a claim racing the kitchen's `ready` is right in
 * both orders: if `ready` lands first the re-checked row is `ready` and the
 * claim writes `assigned`; if the claim lands first the `ready` write finds
 * the agent and promotes.
 *
 * `created_at` is in the predicate for the usual two reasons — it is half the
 * primary key, and it prunes the write to one partition.
 */
export async function claimOrderForAgent(
    orderId: number,
    createdAt: Date,
    agentId: number,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const now = new Date();
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .whereIn("status", DISPATCHABLE_STATUSES)
        .whereNull("delivery_agent_id")
        .update({
            status: conn.raw("CASE WHEN status = ? THEN ? ELSE status END", [
                OrderStatus.READY,
                OrderStatus.ASSIGNED,
            ]),
            delivery_agent_id: agentId,
            assigned_at: now,
            updated_at: now,
        })
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * The second half of an early claim: an order that reached `ready` with an
 * agent already attached becomes `assigned`.
 *
 * Run inside the transaction that wrote `ready`, so `ready`-with-an-agent is
 * never committed — it is invisible to the sweep (which skips attached
 * orders) and to `markPicked` (which needs `assigned`), and a committed one
 * would be stranded between them. `assigned_at` is left alone: it already
 * holds the moment the agent claimed, which is what it means.
 */
export async function promoteClaimedReadyOrder(
    orderId: number,
    createdAt: Date,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .where("status", OrderStatus.READY)
        .whereNotNull("delivery_agent_id")
        .update({status: OrderStatus.ASSIGNED, updated_at: new Date()})
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * The inverse of the claim: hand an order back to the pool.
 *
 * Scoped to the agent who holds it, so one agent can never unclaim another's
 * work, and to `preparing`/`assigned`, so a `picked` order cannot be abandoned
 * with the food already in the bag. An `assigned` order goes back to `ready`;
 * a `preparing` one was never moved by the claim, so it stays `preparing`.
 * `assigned_at` is cleared because the order is genuinely unassigned again —
 * leaving it set would make the next sweep's offer look like a re-offer of a
 * live assignment.
 */
export async function releaseOrderFromAgent(
    orderId: number,
    createdAt: Date,
    agentId: number,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const [row] = await conn("orders")
        .where("id", orderId)
        .where("created_at", createdAt)
        .whereIn("status", [OrderStatus.PREPARING, OrderStatus.ASSIGNED])
        .where("delivery_agent_id", agentId)
        .update({
            status: conn.raw("CASE WHEN status = ? THEN ? ELSE status END", [
                OrderStatus.ASSIGNED,
                OrderStatus.READY,
            ]),
            delivery_agent_id: null,
            assigned_at: null,
            updated_at: new Date(),
        })
        .returning(ORDER_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * The order an agent is currently carrying, if any.
 *
 * Backed by the partial idx_orders_delivery_agent_id_status. This is the
 * authoritative answer to "is this agent busy" — the presence hash holds a
 * copy for the candidate scan to read cheaply, but that copy lives in Redis
 * and is allowed to vanish, so every decision that *releases or assigns work*
 * asks here instead.
 *
 * No created_at bound: an agent holds at most one active order and the
 * partial index is tiny, so the partition fan-out is bounded by how many
 * months have ever existed rather than by how many orders they contain.
 */
export async function findActiveOrderForAgent(
    agentId: number,
    conn: Knex,
): Promise<OrderEntity | undefined> {
    const row = await conn("orders")
        .select(ORDER_COLUMNS)
        .where("delivery_agent_id", agentId)
        .whereIn("status", ACTIVE_AGENT_STATUSES)
        .orderBy("assigned_at", "desc")
        .first();

    return row ? toEntity(row) : undefined;
}

/**
 * GET /api/agents/tasks — one page of an agent's deliveries.
 *
 * Ordered and cursored by `created_at`, not `assigned_at`, which is a
 * deliberate trade. `assigned_at` is what the agent conceptually sorts by, but
 * `orders` is partitioned on `created_at`: ordering by anything else makes
 * every page a fan-out across every month that exists, and no window can prune
 * it. Within one agent's task list the two orders agree anyway — an order is
 * assigned minutes after it is created — so the cost is nil and the saving is
 * the whole partition set.
 *
 * `window` bounds the scan to recent months for the same reason.
 */
export async function findOrdersByAgent(
    agentId: number,
    params: PaginationParams,
    filters: AgentOrderFilters,
    window: CreatedAtWindow,
    conn: Knex,
): Promise<OrderEntity[]> {
    const query = conn("orders")
        .select(ORDER_COLUMNS)
        .where("delivery_agent_id", agentId)
        .where("created_at", ">=", window.from)
        .where("created_at", "<", window.to);

    if (filters.status) query.where("status", filters.status);
    else query.whereIn("status", ACTIVE_AGENT_STATUSES);

    applyCreatedAtCursor(query, params);

    const rows = await query.orderBy("created_at", params.sortOrder).limit(params.limit + 1);
    return rows.map(toEntity);
}

/**
 * The dispatch sweep's input: `preparing` and `ready` orders nobody has
 * claimed. Dispatch starts when the kitchen does, so the agent's drive to the
 * branch overlaps the cooking instead of following it.
 *
 * Backed by the partial idx_orders_status_created_at, which indexes only
 * `('preparing','ready','assigned')` (migration 20260418000130), so the scan
 * never touches the millions of delivered rows beside them.
 *
 * `ready` first, then oldest first. Food that is already up is the order
 * going cold, and with a batch limit a busy lunch of `preparing` orders must
 * not be able to push it out of the pass. Within a status, the order that has
 * been waiting longest is offered first, so no one order starves while the
 * queue churns around it.
 */
export async function findUnclaimedDispatchableOrders(
    window: CreatedAtWindow,
    limit: number,
    conn: Knex,
): Promise<OrderEntity[]> {
    const rows = await conn("orders")
        .select(ORDER_COLUMNS)
        .whereIn("status", DISPATCHABLE_STATUSES)
        .whereNull("delivery_agent_id")
        .where("created_at", ">=", window.from)
        .where("created_at", "<", window.to)
        .orderByRaw("CASE WHEN status = ? THEN 0 ELSE 1 END, created_at ASC", [OrderStatus.READY])
        .limit(limit);

    return rows.map(toEntity);
}

/**
 * The restaurant + branch equality predicates shared by every scoped read.
 * One helper rather than two inline pairs, so a read can never end up
 * filtering by the branch and not the restaurant above it.
 */
function applyScope(query: Knex.QueryBuilder, scope: OrderScope | undefined): void {
    if (!scope) return;

    query.where("restaurant_id", scope.restaurantId).where("branch_id", scope.branchId);
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
