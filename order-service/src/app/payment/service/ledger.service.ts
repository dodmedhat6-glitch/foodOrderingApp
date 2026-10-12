import {injectable} from "tsyringe";
import {Knex} from "knex";
import {PaginationParams} from "../../../lib/http/pagination/cursor-pagination";
import {TransactionEntity} from "../entity/transaction.entity";
import {TransactionMethod, TransactionStatus, TransactionType} from "../enums";
import {
    createTransactionIfNew,
    findPayoutsByRestaurant,
    findTransactionByIdempotencyKey,
    sumLedgerByRestaurant,
} from "../repository/transaction.repo";
import {LedgerRange, RecordPayoutInput, RestaurantLedgerTotals} from "../types";

/**
 * The ledger as other modules see it.
 *
 * `transactions` belongs to this module, and nobody else may import its
 * repository (CLAUDE.md s3). The finance module needs three things from it —
 * write a payout, page through payouts, sum a restaurant's movements — and
 * none of them has anything to do with taking a payment, so they live here
 * rather than growing `PaymentService` further.
 *
 * Every method takes `conn`: the payout write has to commit with the balance
 * debit that justifies it, and the reads run against whichever shard the
 * caller already resolved.
 */
@injectable()
export class LedgerService {
    /**
     * The payout already recorded under this request's key, if any. Read
     * inside the caller's transaction *before* the balance check, so a replay
     * that arrives after the first payout drained the balance is answered
     * with that payout rather than refused as insufficient.
     */
    findPayoutByKey = async (
        restaurantId: number,
        idempotencyKey: string,
        conn: Knex,
    ): Promise<TransactionEntity | undefined> =>
        findTransactionByIdempotencyKey(payoutKey(restaurantId, idempotencyKey), conn);

    /**
     * Writes the payout row inside the caller's transaction.
     *
     * `succeeded` from the start: a payout is recorded *after* operations has
     * made the bank transfer (restaurant-finance.md s4), so there is nothing
     * left to wait for. `src = NULL` is the platform; `dst` stays NULL because
     * core exposes no restaurant -> owner lookup, and the restaurant is carried
     * by `restaurant_id` instead.
     *
     * Returns `undefined` when the unique `idempotency_key` already holds a
     * row — the caller must then not move the balance a second time.
     */
    recordPayout = async (
        input: RecordPayoutInput,
        conn: Knex,
    ): Promise<TransactionEntity | undefined> =>
        createTransactionIfNew(
            {
                region: input.region,
                orderId: null,
                orderPublicId: null,
                type: TransactionType.PAYOUT,
                method: TransactionMethod.BANK_TRANSFER,
                providerId: null,
                providerReferenceId: input.providerReferenceId,
                status: TransactionStatus.SUCCEEDED,
                amount: input.amount,
                currency: input.currency,
                srcAccId: null,
                dstAccId: null,
                restaurantId: input.restaurantId,
                idempotencyKey: payoutKey(input.restaurantId, input.idempotencyKey),
            },
            conn,
        );

    /** One page of a restaurant's payouts, limit + 1 rows. */
    listPayouts = async (
        restaurantId: number,
        range: LedgerRange,
        params: PaginationParams,
        conn: Knex,
    ): Promise<TransactionEntity[]> => findPayoutsByRestaurant(restaurantId, range, params, conn);

    /** A restaurant's sales, commission, refunds and payouts over a range. */
    summarizeRestaurant = async (
        restaurantId: number,
        range: LedgerRange,
        conn: Knex,
    ): Promise<RestaurantLedgerTotals[]> => sumLedgerByRestaurant(restaurantId, range, conn);
}

/**
 * Scoped to the restaurant so one admin key reused across two restaurants
 * records two payouts, not one payout and a silent no-op.
 */
function payoutKey(restaurantId: number, idempotencyKey: string): string {
    return `payout:${restaurantId}:${idempotencyKey}`;
}
