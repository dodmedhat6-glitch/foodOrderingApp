import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {db, dbArchive} from "../../../lib/knex/knex";
import {archiveBoundary} from "../../../lib/knex/archive-boundary";
import {logger} from "../../../lib/logger/logger";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {
    buildPaginationResultBy,
    PaginationMeta,
    PaginationParams,
} from "../../../lib/http/pagination/cursor-pagination";
import {LedgerService} from "../../payment/service/ledger.service";
import {TransactionEntity} from "../../payment/entity/transaction.entity";
import {RestaurantLedgerTotals} from "../../payment/types";
import {RestaurantBalanceEntity} from "../entity/restaurant-balance.entity";
import {CreatePayoutRequestDTO} from "../dto/finance.request.dto";
import {
    FinanceSummaryResponseDTO,
    PayoutResponseDTO,
    RestaurantBalanceResponseDTO,
} from "../dto/finance.response.dto";
import {FinanceWsEvent} from "../enums";
import {InsufficientBalanceError, PayoutIdempotencyConflictError} from "../errors";
import {FinanceRange, PayoutCallContext} from "../types";
import {
    adjustBalance,
    findBalanceForUpdate,
    findBalancesByRestaurant,
    lockBalanceForUpdate,
} from "../repository/restaurant-balance.repo";

/**
 * The restaurant's money: its running balance, the payouts that draw it down,
 * and a summary of the ledger behind both.
 *
 * Two writers move the balance — settlement credits it when an order is
 * delivered (`creditForDelivery`, called by the delivery module inside its own
 * transaction) and an admin debits it by recording a payout. Both take the
 * same `FOR UPDATE` lock on the `(restaurant, currency)` row first, which is
 * what serialises one restaurant's money without serialising anyone else's.
 *
 * The ledger rows (`transactions`) belong to the payment module and are
 * reached through `LedgerService`, never its repository (CLAUDE.md s3).
 */
@injectable()
export class FinanceService {
    constructor(@inject(TOKENS.LedgerService) private readonly ledger: LedgerService) {}

    /**
     * Credits a restaurant for a delivered order, inside the caller's
     * transaction.
     *
     * **Takes `conn` and never opens its own.** The credit has to commit with
     * the status flip and the ledger rows that justify it — a balance that
     * moved for an order which then failed to settle would be money invented
     * out of a rollback.
     *
     * The lock is taken before the adjustment rather than relying on the
     * UPDATE's own row lock, because settlement computes the commission from
     * values it read earlier: taking the lock first is what makes the whole
     * read-compute-write sequence serial per restaurant, not just the final
     * statement.
     */
    creditForDelivery = async (
        restaurantId: number,
        currency: string,
        region: string,
        amountMinor: number,
        conn: Knex,
    ): Promise<RestaurantBalanceEntity> => {
        await lockBalanceForUpdate(restaurantId, currency, region, conn);
        return adjustBalance(restaurantId, currency, amountMinor, conn);
    };

    /** Every currency this restaurant holds a balance in. */
    getBalances = async (
        restaurantId: number,
        region: string,
    ): Promise<RestaurantBalanceEntity[]> => findBalancesByRestaurant(restaurantId, db(region));

    /**
     * `GET /restaurants/{restaurantId}/finance/balance`.
     *
     * Read from the primary and never cached (restaurant-finance.md s2): it
     * is a primary-key lookup, and it is the number an owner reconciles their
     * bank statement against — a stale one is a support ticket.
     */
    getBalance = async (
        restaurantId: number,
        region: string,
    ): Promise<RestaurantBalanceResponseDTO> =>
        RestaurantBalanceResponseDTO.from(restaurantId, await this.getBalances(restaurantId, region));

    /**
     * `GET /restaurants/{restaurantId}/finance/payouts?from=&to=`.
     *
     * A range reaching below the archive boundary reads both clusters and
     * merges them, de-duplicated by id, for the same reasons as the order
     * lists (OrderService.readAcross): until archival catches up after New
     * Year, last year's payouts are still hot, and a crash mid-move leaves a
     * row in both.
     */
    listPayouts = async (
        restaurantId: number,
        range: FinanceRange,
        params: PaginationParams,
        region: string,
    ): Promise<{data: PayoutResponseDTO[]; meta: PaginationMeta}> => {
        let rows = await this.ledger.listPayouts(restaurantId, range, params, db(region));
        if (range.from < archiveBoundary()) {
            const hotIds = new Set(rows.map((row) => row.id));
            const archived = (
                await this.ledger.listPayouts(restaurantId, range, params, dbArchive(region))
            ).filter((row) => !hotIds.has(row.id));
            const direction = params.sortOrder === "asc" ? 1 : -1;
            rows = [...rows, ...archived]
                .sort(
                    (a, b) =>
                        direction * (a.createdAt.getTime() - b.createdAt.getTime()) || direction * (a.id - b.id),
                )
                .slice(0, params.limit + 1);
        }
        const page = buildPaginationResultBy(rows, params.limit, (row) =>
            String(row.createdAt.getTime()),
        );
        return {data: page.data.map(PayoutResponseDTO.from), meta: page.meta};
    };

    /**
     * `GET /restaurants/{restaurantId}/finance/summary?from=&to=`.
     *
     * Below the archive boundary the two clusters' sums are added per
     * currency. Sums cannot be de-duplicated by id, so a row caught in both
     * clusters by a crash mid-move is counted twice until the next archival
     * run deletes the hot copy — a window of one night at most, on a path
     * that only ever existed because of a crash.
     */
    getSummary = async (
        restaurantId: number,
        range: FinanceRange,
        region: string,
    ): Promise<FinanceSummaryResponseDTO> => {
        let totals = await this.ledger.summarizeRestaurant(restaurantId, range, db(region));
        if (range.from < archiveBoundary()) {
            const archived = await this.ledger.summarizeRestaurant(restaurantId, range, dbArchive(region));
            totals = addTotals(totals, archived);
        }
        return FinanceSummaryResponseDTO.from(restaurantId, range, totals);
    };

    /**
     * `POST /restaurants/{restaurantId}/finance/payouts` — records a bank
     * transfer operations has already made (restaurant-finance.md s4).
     *
     * One transaction, in this order:
     *
     *  1. **Lock the balance row.** Everything after reads the balance or
     *     depends on nobody else moving it.
     *  2. **Look for this key's payout.** Before the sufficiency check, so a
     *     replay arriving after the first payout drained the balance gets that
     *     payout back instead of a 409. The HTTP idempotency layer normally
     *     answers a replay before it reaches here; this is the answer when that
     *     layer's record has expired or been flushed.
     *  3. **Refuse an overdraw.** `balance < amount` → 409. A missing row is a
     *     zero balance. The balance may already be negative (a post-payout
     *     refund), and then any payout is refused until deliveries earn it back.
     *  4. **Ledger row, then balance debit.** The row goes through
     *     `ON CONFLICT DO NOTHING`; if it yields, the debit is skipped — the
     *     unique key, not this method's control flow, is the final guard
     *     against paying twice (CLAUDE.md s8, rule 3).
     *
     * No upstream call: the restaurant need not be confirmed against core,
     * because a restaurant with no settled deliveries has no balance row and is
     * refused at step 3 anyway.
     */
    recordPayout = async (
        restaurantId: number,
        dto: CreatePayoutRequestDTO,
        ctx: PayoutCallContext,
    ): Promise<PayoutResponseDTO> => {
        const conn = db(ctx.region);
        const trx = await conn.transaction();
        let payout: TransactionEntity;
        let balanceAfter: number;
        try {
            const balance = await findBalanceForUpdate(restaurantId, dto.currency, trx);

            const existing = await this.ledger.findPayoutByKey(restaurantId, ctx.idempotencyKey, trx);
            if (existing) {
                await trx.commit();
                if (!samePayout(existing, dto)) throw PayoutIdempotencyConflictError;
                return PayoutResponseDTO.from(existing);
            }

            if (!balance || balance.balance < dto.amount) throw InsufficientBalanceError;

            const created = await this.ledger.recordPayout(
                {
                    region: ctx.region,
                    restaurantId,
                    amount: dto.amount,
                    currency: dto.currency,
                    providerReferenceId: dto.providerReferenceId,
                    idempotencyKey: ctx.idempotencyKey,
                },
                trx,
            );
            // Only reachable if the same key raced in under a *different*
            // currency — a different balance row, so the lock above did not
            // serialise them. The other request owns the key.
            if (!created) throw PayoutIdempotencyConflictError;
            payout = created;

            balanceAfter = (await adjustBalance(restaurantId, dto.currency, -dto.amount, trx)).balance;
            await trx.commit();
        } catch (err) {
            if (!trx.isCompleted()) await trx.rollback();
            throw err;
        }

        wsPublish([wsChannels.restaurant(restaurantId)], FinanceWsEvent.PAYOUT_RECORDED, {
            payoutId: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            balance: balanceAfter,
            ts: new Date().toISOString(),
        });

        logger.info("payout recorded", {
            restaurantId,
            region: ctx.region,
            payoutId: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            balanceAfter,
            correlationId: ctx.correlationId,
        });

        return PayoutResponseDTO.from(payout);
    };
}

/** Per-currency sum of two clusters' ledger totals, sorted by currency. */
function addTotals(a: RestaurantLedgerTotals[], b: RestaurantLedgerTotals[]): RestaurantLedgerTotals[] {
    const byCurrency = new Map<string, RestaurantLedgerTotals>();
    for (const t of [...a, ...b]) {
        const acc = byCurrency.get(t.currency);
        byCurrency.set(
            t.currency,
            acc
                ? {
                      currency: t.currency,
                      grossSales: acc.grossSales + t.grossSales,
                      commission: acc.commission + t.commission,
                      refunds: acc.refunds + t.refunds,
                      payouts: acc.payouts + t.payouts,
                  }
                : {...t},
        );
    }
    return [...byCurrency.values()].sort((x, y) => x.currency.localeCompare(y.currency));
}

/** Whether a recorded payout is the one this request describes. */
function samePayout(existing: TransactionEntity, dto: CreatePayoutRequestDTO): boolean {
    return (
        existing.amount === dto.amount &&
        existing.currency === dto.currency &&
        existing.providerReferenceId === dto.providerReferenceId
    );
}
