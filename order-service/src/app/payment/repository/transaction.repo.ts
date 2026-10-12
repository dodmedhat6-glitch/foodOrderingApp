import {Knex} from "knex";
import {TransactionEntity} from "../entity/transaction.entity";
import {TransactionMethod, TransactionStatus, TransactionType} from "../enums";
import {PaginationParams} from "../../../lib/http/pagination/cursor-pagination";
import {CreateTransactionInput, LedgerRange, RestaurantLedgerTotals} from "../types";

const TRANSACTION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "order_public_id",
    "transaction_type",
    "method",
    "provider_id",
    "provider_reference_id",
    "status",
    "amount",
    "currency",
    "src_acc_id",
    "dst_acc_id",
    "restaurant_id",
    "is_refunded",
    "refunded_payment_id",
    "idempotency_key",
    "created_at",
    "updated_at",
];

function toEntity(row: any): TransactionEntity {
    return new TransactionEntity({
        id: Number(row.id),
        region: row.region,
        orderId: row.order_id === null ? null : Number(row.order_id),
        orderPublicId: row.order_public_id,
        type: row.transaction_type as TransactionType,
        method: row.method as TransactionMethod,
        providerId: row.provider_id === null ? null : Number(row.provider_id),
        providerReferenceId: row.provider_reference_id,
        status: row.status as TransactionStatus,
        amount: row.amount,
        currency: row.currency,
        srcAccId: row.src_acc_id === null ? null : Number(row.src_acc_id),
        dstAccId: row.dst_acc_id === null ? null : Number(row.dst_acc_id),
        restaurantId: row.restaurant_id === null ? null : Number(row.restaurant_id),
        isRefunded: row.is_refunded,
        refundedPaymentId: row.refunded_payment_id === null ? null : Number(row.refunded_payment_id),
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createTransaction(
    data: CreateTransactionInput,
    conn: Knex,
): Promise<TransactionEntity> {
    const now = new Date();
    const [row] = await conn("transactions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_public_id: data.orderPublicId,
            transaction_type: data.type,
            method: data.method,
            provider_id: data.providerId,
            provider_reference_id: data.providerReferenceId ?? null,
            status: data.status,
            amount: data.amount,
            currency: data.currency,
            src_acc_id: data.srcAccId,
            dst_acc_id: data.dstAccId,
            restaurant_id: data.restaurantId,
            refunded_payment_id: data.refundedPaymentId ?? null,
            idempotency_key: data.idempotencyKey ?? null,
            created_at: now,
            updated_at: now,
        })
        .returning(TRANSACTION_COLUMNS);

    return toEntity(row);
}

/**
 * Insert that yields to the unique `idempotency_key` instead of erroring on
 * it, returning `undefined` when the row was already there.
 *
 * `ON CONFLICT DO NOTHING` rather than a catch, because this runs inside the
 * webhook's transaction: in Postgres a constraint violation aborts the whole
 * transaction, so "try the insert and handle the duplicate" would poison
 * every statement after it. Yielding in SQL keeps the transaction usable and
 * keeps the constraint — not application logic — as the thing that actually
 * prevents a double credit.
 */
export async function createTransactionIfNew(
    data: CreateTransactionInput,
    conn: Knex,
): Promise<TransactionEntity | undefined> {
    const now = new Date();
    const [row] = await conn("transactions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_public_id: data.orderPublicId,
            transaction_type: data.type,
            method: data.method,
            provider_id: data.providerId,
            provider_reference_id: data.providerReferenceId ?? null,
            status: data.status,
            amount: data.amount,
            currency: data.currency,
            src_acc_id: data.srcAccId,
            dst_acc_id: data.dstAccId,
            restaurant_id: data.restaurantId,
            refunded_payment_id: data.refundedPaymentId ?? null,
            idempotency_key: data.idempotencyKey ?? null,
            created_at: now,
            updated_at: now,
        })
        .onConflict("idempotency_key")
        .ignore()
        .returning(TRANSACTION_COLUMNS);

    return row ? toEntity(row) : undefined;
}

export async function findTransactionById(
    id: number,
    conn: Knex,
): Promise<TransactionEntity | undefined> {
    const row = await conn("transactions").select(TRANSACTION_COLUMNS).where("id", id).first();
    return row ? toEntity(row) : undefined;
}

/** The ledger for one order — backed by idx_transactions_order_id. */
export async function findTransactionsByOrderId(
    orderId: number,
    conn: Knex,
): Promise<TransactionEntity[]> {
    const rows = await conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("order_id", orderId)
        .orderBy("id", "asc");

    return rows.map(toEntity);
}

/**
 * Batch fetch for a page of orders. The `whereIn` is the point — a caller
 * mapping over orders and asking per row would be the N+1 CLAUDE.md s9.1
 * forbids, so there is deliberately no single-order variant to reach for in
 * a loop.
 */
export async function findTransactionsByOrderIds(
    orderIds: number[],
    conn: Knex,
): Promise<TransactionEntity[]> {
    if (orderIds.length === 0) return [];

    const rows = await conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .whereIn("order_id", orderIds)
        .orderBy("id", "asc");

    return rows.map(toEntity);
}

/**
 * Looks a row up by the upstream key the unique constraint is on.
 *
 * Used to tell a duplicate webhook from a genuine conflict: if the insert
 * would collide, the row that already exists *is* the answer, and returning
 * it is how the handler stays idempotent rather than erroring on a replay.
 */
export async function findTransactionByIdempotencyKey(
    idempotencyKey: string,
    conn: Knex,
): Promise<TransactionEntity | undefined> {
    const row = await conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("idempotency_key", idempotencyKey)
        .first();

    return row ? toEntity(row) : undefined;
}

/**
 * How much of a charge has already been given back — pending refunds
 * included.
 *
 * Counting pending ones is deliberate: a refund we have asked Kashier for but
 * not yet seen settle is money on its way out, and leaving it out of the sum
 * would let a second request refund the same amount again while the first is
 * in flight. A refund that later fails is excluded by `status`, which frees
 * the amount up again.
 */
export async function sumRefundedAmount(chargeId: number, conn: Knex): Promise<number> {
    const row = await conn("transactions")
        .where("refunded_payment_id", chargeId)
        .where("transaction_type", TransactionType.REFUND)
        .whereIn("status", [TransactionStatus.PENDING, TransactionStatus.SUCCEEDED])
        .sum<{sum: string | null}>("amount as sum")
        .first();

    return Number(row?.sum ?? 0);
}

/**
 * Finds the refund row a refund webhook is reporting on.
 *
 * Settlement is **FIFO among the order's pending refunds**, narrowed by the
 * provider's transaction id when that narrows anything.
 *
 * Matching on the provider reference alone is not enough, and the reason is
 * observed rather than theoretical: Kashier has been seen returning the
 * *same* `transactionId` for two separate refunds on one order, so the
 * reference identifies the order's refund stream, not a single refund. What
 * is reliable is that refunds on one order are issued one at a time by an
 * admin and settle in the order they were asked for — so the oldest pending
 * one is the one being reported. Narrowing by reference first still helps
 * when the provider does give distinct ids.
 *
 * Only `pending` rows are candidates: a settled refund is not waiting for
 * news, and matching one would turn a replay into a second settlement
 * attempt. Backed by idx_transactions_order_id.
 */
export async function findPendingRefundToSettle(
    orderId: number,
    providerReferenceId: string | undefined,
    conn: Knex,
): Promise<TransactionEntity | undefined> {
    const pending = () =>
        conn("transactions")
            .select(TRANSACTION_COLUMNS)
            .where("order_id", orderId)
            .where("transaction_type", TransactionType.REFUND)
            .where("status", TransactionStatus.PENDING)
            .orderBy("id", "asc");

    if (providerReferenceId) {
        const byReference = await pending().where("provider_reference_id", providerReferenceId).first();
        if (byReference) return toEntity(byReference);
    }

    const oldest = await pending().first();
    return oldest ? toEntity(oldest) : undefined;
}

/**
 * Compare-and-set on the current status, so a webhook replay that slipped
 * past the de-dup gate still can't settle the same refund twice — the second
 * update touches zero rows and the caller treats it as already done.
 */
export async function updateTransactionStatus(
    id: number,
    expectedStatus: TransactionStatus,
    data: {status: TransactionStatus; providerReferenceId?: string},
    conn: Knex,
): Promise<TransactionEntity | undefined> {
    const patch: Record<string, unknown> = {status: data.status, updated_at: new Date()};
    if (data.providerReferenceId) patch.provider_reference_id = data.providerReferenceId;

    const [row] = await conn("transactions")
        .where("id", id)
        .where("status", expectedStatus)
        .update(patch)
        .returning(TRANSACTION_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * Flags a charge as refunded.
 *
 * Set only once the refunds against it reach its full amount — a partial
 * refund leaves the charge refundable, and the remaining headroom is computed
 * from `sumRefundedAmount`, not from this flag. The flag exists so a reader
 * can see "this payment was given back" without summing the ledger.
 */
export async function markChargeFullyRefunded(chargeId: number, conn: Knex): Promise<void> {
    await conn("transactions")
        .where("id", chargeId)
        .update({is_refunded: true, updated_at: new Date()});
}

/**
 * One page of a restaurant's payouts — backed by
 * idx_transactions_restaurant_type_created_at: `restaurant_id` and
 * `transaction_type` are the equality columns, `created_at` the range.
 *
 * Returns limit + 1 rows so the caller can tell whether another page exists,
 * matching `findEarningsByAgent`. The cursor is epoch millis, never a
 * stringified Date (see `buildPaginationResultBy`).
 */
export async function findPayoutsByRestaurant(
    restaurantId: number,
    range: LedgerRange,
    params: PaginationParams,
    conn: Knex,
): Promise<TransactionEntity[]> {
    const query = conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("restaurant_id", restaurantId)
        .where("transaction_type", TransactionType.PAYOUT)
        .where("created_at", ">=", range.from)
        .where("created_at", "<", range.to);

    if (params.cursor) {
        const millis = Number(params.cursor);
        if (Number.isFinite(millis)) {
            query.where("created_at", params.sortOrder === "asc" ? ">" : "<", new Date(millis));
        }
    }

    const rows = await query
        .orderBy("created_at", params.sortOrder)
        .orderBy("id", params.sortOrder)
        .limit(params.limit + 1);
    return rows.map(toEntity);
}

/**
 * A restaurant's ledger summed by category over a range, one row per
 * currency — the finance summary (docs/business-logic/restaurant-finance.md
 * s8). One statement with a `FILTER` per category rather than a query per
 * category: same index, one pass.
 *
 * Only `succeeded` rows count. A pending refund is not yet money that left,
 * and a failed charge is an audit row, not a sale.
 *
 * `::bigint` because a year of sales overflows INT; node-postgres hands
 * bigint back as a string, hence the `Number()` — safe well past any
 * restaurant's turnover in minor units.
 */
export async function sumLedgerByRestaurant(
    restaurantId: number,
    range: LedgerRange,
    conn: Knex,
): Promise<RestaurantLedgerTotals[]> {
    const sumOf = (filter: string) =>
        `COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded' AND ${filter}), 0)::bigint`;

    const rows = await conn("transactions")
        .where("restaurant_id", restaurantId)
        .where("created_at", ">=", range.from)
        .where("created_at", "<", range.to)
        .groupBy("currency")
        .orderBy("currency", "asc")
        .select(
            "currency",
            conn.raw(`${sumOf("transaction_type IN ('charge','cod_collection')")} AS gross_sales`),
            conn.raw(`${sumOf("transaction_type = 'commission'")} AS commission`),
            conn.raw(`${sumOf("transaction_type = 'refund'")} AS refunds`),
            conn.raw(`${sumOf("transaction_type = 'payout'")} AS payouts`),
        );

    return rows.map((row: any) => ({
        currency: row.currency,
        grossSales: Number(row.gross_sales),
        commission: Number(row.commission),
        refunds: Number(row.refunds),
        payouts: Number(row.payouts),
    }));
}
