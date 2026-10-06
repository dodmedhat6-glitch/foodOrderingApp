import type {Knex} from "knex";

/**
 * `payment_providers` — the provider lookup, replicated identically onto every
 * shard rather than sharded (docs/database-design.md s3.3). It is a handful of
 * rows that every region needs, and keeping a copy per shard means a payment
 * write never has to reach across clusters to resolve a provider id.
 *
 * Ids are assigned explicitly, not by a sequence: the same number must mean
 * the same provider on every shard, because `payment_sessions.provider_id` and
 * `transactions.provider_id` are compared across regions in reporting.
 *
 * `cod` is a provider in the same sense `kashier` is — it is how the money
 * moved. Carrying it here keeps `transactions.provider_id` non-conditional and
 * lets a COD collection be reported alongside an online charge.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_providers (
            id          INT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
            priority    SMALLINT NOT NULL DEFAULT 100
        );
    `);

    // Seeded, not migrated-in later: the payment module resolves a provider by
    // name on every init and would 500 on an empty table.
    await knex("payment_providers").insert([
        {id: 1, name: "kashier", is_enabled: true, priority: 10},
        {id: 2, name: "cod", is_enabled: true, priority: 20},
    ]);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_providers;`);
}
