import type {Knex} from "knex";

/**
 * `restaurant_balances` — what the platform owes each restaurant, right now
 * (docs/database-design.md s3.6).
 *
 * One row per (restaurant, currency). Incremented inside the settlement
 * transaction when an order reaches `delivered` (by `subtotal - commission`),
 * decremented when a payout is recorded (Phase 4). It is a *running total*,
 * not a ledger: the ledger is `transactions`, and this row is the
 * materialised balance so the owner's dashboard is one PK lookup rather than
 * a sum over every movement the restaurant has ever had.
 *
 * Three deliberate choices:
 *
 *  1. **No `id` column.** The natural key `(restaurant_id, currency)` is the
 *     PK. There is exactly one balance per pair, every read is by that pair,
 *     and a surrogate key would only add a second way to name the same row.
 *     This is the one table in the service without a bigserial.
 *  2. **`balance` may go negative.** No CHECK, on purpose. A refund issued
 *     after a payout has already swept the balance is a real sequence, and
 *     the honest record of it is a negative number the next delivery works
 *     off — not a constraint violation that aborts the refund.
 *  3. **No FK to core's `restaurants`.** Cross-service, so logical only
 *     (CLAUDE.md s7).
 *
 * Writers take `SELECT ... FOR UPDATE` on the row inside the settlement
 * transaction. That lock is the serialisation point for one restaurant's
 * money, which is why it is scoped to one restaurant and not to a table.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE restaurant_balances (
            restaurant_id   BIGINT NOT NULL,          -- logical FK -> core.restaurants.id
            region          TEXT NOT NULL,
            currency        TEXT NOT NULL,
            balance         INT NOT NULL DEFAULT 0,   -- minor units; may be negative (see header)
            updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT pk_restaurant_balances PRIMARY KEY (restaurant_id, currency)
        );
    `);
    // No secondary index: the PK covers the only query there is — the
    // single-row lookup by (restaurant_id, currency) that both the settlement
    // lock and GET /api/restaurant/balance perform.
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS restaurant_balances;`);
}
