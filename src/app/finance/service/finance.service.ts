import {injectable} from "tsyringe";
import {Knex} from "knex";
import {db} from "../../../lib/knex/knex";
import {RestaurantBalanceEntity} from "../entity/restaurant-balance.entity";
import {
    adjustBalance,
    findBalancesByRestaurant,
    lockBalanceForUpdate,
} from "../repository/restaurant-balance.repo";

/**
 * The restaurant's running balance.
 *
 * Exists in this phase for one caller — the settlement transaction, which
 * credits a restaurant when an order is delivered. `restaurant_balances` is
 * this module's table, and the delivery module may not reach into another
 * module's repository (CLAUDE.md s3), so the credit goes through here.
 *
 * Phase 4 adds the read endpoints and payouts on top; `getBalances` is here
 * already because it is one line and settlement's correctness is far easier to
 * check against a reader than against a column.
 */
@injectable()
export class FinanceService {
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
}
