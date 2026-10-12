/**
 * The `restaurant_balances` row: what the platform currently owes one
 * restaurant, in one currency.
 *
 * A running total, not a ledger — the ledger is `transactions`. This row
 * exists so the owner's dashboard is a primary-key lookup instead of a sum
 * over every movement the restaurant has ever had.
 *
 * No `id`: the natural key `(restaurantId, currency)` identifies the row, and
 * `balance` is integer minor units which may legitimately be negative (see
 * migrations/20260418000060_create_restaurant_balances.ts).
 */
export class RestaurantBalanceEntity {
    restaurantId: number;
    region: string;
    currency: string;
    balance: number;
    updatedAt: Date;

    constructor(data: Partial<RestaurantBalanceEntity>) {
        this.restaurantId = data.restaurantId!;
        this.region = data.region!;
        this.currency = data.currency!;
        this.balance = data.balance!;
        this.updatedAt = data.updatedAt!;
    }
}
