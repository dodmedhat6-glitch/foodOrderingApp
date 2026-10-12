import {Knex} from "knex";
import {RestaurantBalanceEntity} from "../entity/restaurant-balance.entity";

const RESTAURANT_BALANCE_COLUMNS = ["restaurant_id", "region", "currency", "balance", "updated_at"];

function toEntity(row: any): RestaurantBalanceEntity {
    return new RestaurantBalanceEntity({
        restaurantId: Number(row.restaurant_id),
        region: row.region,
        currency: row.currency,
        balance: row.balance,
        updatedAt: row.updated_at,
    });
}

/**
 * Takes the row lock that serialises one restaurant's money, creating the row
 * first if this is their first delivery.
 *
 * The two halves are one statement each and both matter:
 *
 *  1. `INSERT ... ON CONFLICT DO NOTHING` — a restaurant has no balance row
 *     until their first settlement, and two concurrent first deliveries would
 *     otherwise race to create it. `DO NOTHING` rather than a catch, because
 *     this runs inside the settlement transaction and a constraint violation
 *     would abort every statement after it (CLAUDE.md s8).
 *  2. `SELECT ... FOR UPDATE` — the actual lock. Every writer of this row
 *     (settlement here, payouts in Phase 4) must take it before reading the
 *     balance it is about to add to, or two concurrent deliveries both read
 *     the old value and one increment is lost.
 *
 * Scoped to one (restaurant, currency), so contention is bounded by a single
 * restaurant's delivery rate rather than by the platform's.
 */
export async function lockBalanceForUpdate(
    restaurantId: number,
    currency: string,
    region: string,
    conn: Knex,
): Promise<RestaurantBalanceEntity> {
    await conn("restaurant_balances")
        .insert({
            restaurant_id: restaurantId,
            region,
            currency,
            balance: 0,
            updated_at: new Date(),
        })
        .onConflict(["restaurant_id", "currency"])
        .ignore();

    const row = await conn("restaurant_balances")
        .select(RESTAURANT_BALANCE_COLUMNS)
        .where("restaurant_id", restaurantId)
        .where("currency", currency)
        .forUpdate()
        .first();

    return toEntity(row);
}

/**
 * Moves the balance by `delta` minor units — positive on a delivery, negative
 * on a payout.
 *
 * A relative `balance + ?` rather than writing a value computed in JS: the
 * caller holds the row lock, so either form is correct, but the relative form
 * stays correct if a future caller forgets the lock. No CHECK bounds it below
 * zero, deliberately — a refund issued after a payout has swept the balance is
 * a real sequence, and the honest record is a negative number the next
 * delivery works off (see the migration header).
 */
export async function adjustBalance(
    restaurantId: number,
    currency: string,
    delta: number,
    conn: Knex,
): Promise<RestaurantBalanceEntity> {
    const [row] = await conn("restaurant_balances")
        .where("restaurant_id", restaurantId)
        .where("currency", currency)
        .update({
            balance: conn.raw("balance + ?", [delta]),
            updated_at: new Date(),
        })
        .returning(RESTAURANT_BALANCE_COLUMNS);

    return toEntity(row);
}

/** Every currency a restaurant holds a balance in, for `GET /restaurant/balance`. */
export async function findBalancesByRestaurant(
    restaurantId: number,
    conn: Knex,
): Promise<RestaurantBalanceEntity[]> {
    const rows = await conn("restaurant_balances")
        .select(RESTAURANT_BALANCE_COLUMNS)
        .where("restaurant_id", restaurantId)
        .orderBy("currency", "asc");

    return rows.map(toEntity);
}
