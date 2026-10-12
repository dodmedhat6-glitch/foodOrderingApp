import type {Knex} from "knex";

/**
 * Gives the ledger a restaurant to answer to.
 *
 * Phase 4 reads the ledger per restaurant — the payout history, and the
 * finance summary that sums sales, commission, refunds and payouts over a
 * range. `20260418000050` planned to key payouts on `dst_acc_id = ownerId`,
 * but that never became true: core exposes no restaurant -> owner lookup, so
 * settlement writes its commission with `src_acc_id = NULL`
 * (DeliveryService.markDelivered), and a charge or refund names only the
 * customer. Nothing in the table said which restaurant a row belonged to.
 *
 * `restaurant_id` is that answer, set on every row written from here on:
 * charges, refunds, COD collections and commissions copy it off the order,
 * and a payout carries it from the request. NULL is reserved for a movement
 * that belongs to no restaurant (none today). Logical FK to core's
 * `restaurants`, like every cross-service reference (CLAUDE.md s7).
 *
 * The backfill reads `orders` by id alone, which fans out across every
 * partition — acceptable once, in a migration, and never on a request path.
 *
 * `idx_transactions_dst_acc_type_created_at` is dropped: the query it was
 * created for keys on the restaurant now, and no other query reads it.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE transactions ADD COLUMN restaurant_id BIGINT NULL;  -- logical FK -> core.restaurants.id

        UPDATE transactions t
           SET restaurant_id = o.restaurant_id
          FROM orders o
         WHERE t.order_id = o.id
           AND t.restaurant_id IS NULL;

        -- Payouts have no order, but their ledger key is payout:<restaurantId>:<key>
        -- (LedgerService.payoutKey), so a down/up of this migration does not
        -- orphan them.
        UPDATE transactions
           SET restaurant_id = split_part(idempotency_key, ':', 2)::bigint
         WHERE transaction_type = 'payout'
           AND restaurant_id IS NULL
           AND idempotency_key ~ '^payout:[0-9]+:';

        DROP INDEX IF EXISTS idx_transactions_dst_acc_type_created_at;

        -- supports GET /restaurants/:restaurantId/finance/payouts (type = 'payout')
        -- and GET /restaurants/:restaurantId/finance/summary (range over every type)
        CREATE INDEX idx_transactions_restaurant_type_created_at
            ON transactions (restaurant_id, transaction_type, created_at DESC)
            WHERE restaurant_id IS NOT NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP INDEX IF EXISTS idx_transactions_restaurant_type_created_at;
        CREATE INDEX idx_transactions_dst_acc_type_created_at
            ON transactions (dst_acc_id, transaction_type, created_at DESC)
            WHERE transaction_type = 'payout';
        ALTER TABLE transactions DROP COLUMN IF EXISTS restaurant_id;
    `);
}
