import type {Knex} from "knex";
import {resolveMigrationRegion} from "../lib/knex/migration-region";

/**
 * `payment_providers` — the provider lookup, replicated onto every shard
 * rather than sharded (docs/database-design.md s3.3). It is a handful of rows
 * that every region needs, and keeping a copy per shard means a payment write
 * never has to reach across clusters to resolve a provider id.
 *
 * Ids are assigned explicitly, not by a sequence: the same number must mean
 * the same provider on every shard, because `payment_sessions.provider_id` and
 * `transactions.provider_id` are compared across regions in reporting.
 *
 * Only **external gateways** belong here. Cash on delivery is a payment
 * *method*, not a provider — there is no gateway behind it, nothing to
 * authorize against and no reference id to quote — so a COD movement is
 * `transactions.method = 'cod'` / `orders.payment_method = 'cod'` with
 * `provider_id` left NULL.
 *
 * The *schema* is identical on every shard; the *rows* are not. A gateway is
 * seeded only where it can actually take money, so `kashier` lands on `eg`
 * only. `providerIdOf` throws on a shard that has no row for the provider the
 * configured adapter names, which is the intended behaviour: it says "this
 * region has no online rail yet" rather than writing a session against a
 * gateway that will never settle it.
 */
const PROVIDERS_BY_REGION: Record<string, Array<{id: number; name: string; priority: number}>> = {
    eg: [{id: 1, name: "kashier", priority: 10}],
};

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
    const providers = PROVIDERS_BY_REGION[await resolveMigrationRegion(knex)] ?? [];
    if (providers.length > 0) {
        await knex("payment_providers").insert(
            providers.map((p) => ({...p, is_enabled: true})),
        );
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_providers;`);
}
