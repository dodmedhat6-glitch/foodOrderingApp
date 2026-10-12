import type {Knex} from "knex";

/**
 * Widens the dispatch sweep's partial index to cover `preparing`.
 *
 * Dispatch now starts when the kitchen does rather than when the food is up
 * (order.repo.findUnclaimedDispatchableOrders), so the sweep scans
 * `preparing` as well as `ready`. Left at `('ready','assigned')`, the index
 * would no longer satisfy the sweep's predicate and every pass would fall back
 * to scanning whole partitions.
 *
 * Drop-and-recreate rather than an edit of `20260418000020`: that migration is
 * already applied on existing shards. On a partitioned table both statements
 * cascade to every partition, so no per-partition DDL is needed here.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP INDEX IF EXISTS idx_orders_status_created_at;
        CREATE INDEX idx_orders_status_created_at ON orders (status, created_at)
            WHERE status IN ('preparing','ready','assigned');
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP INDEX IF EXISTS idx_orders_status_created_at;
        CREATE INDEX idx_orders_status_created_at ON orders (status, created_at)
            WHERE status IN ('ready','assigned');
    `);
}
