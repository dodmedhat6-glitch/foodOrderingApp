import type {Knex} from "knex";
import {resolveMigrationRegion} from "../lib/knex/migration-region";

/**
 * Corrects the `payment_providers` seed on shards that already ran
 * `20260418000010` before it was fixed.
 *
 * Two rows are wrong on those shards:
 *
 *  - `(2, 'cod')` — cash on delivery is a payment *method*, not a provider.
 *    Nothing ever read it: `provider_id = 2` appears in no `transactions`,
 *    `payment_sessions` or `payment_webhook_events` row, because the COD paths
 *    key off `method = 'cod'` and leave `provider_id` NULL. Dead data that
 *    invited a wrong lookup.
 *  - `(1, 'kashier')` on any shard but `eg` — the gateway is seeded only where
 *    it can actually take money, and a row on `sa` would let a session be
 *    written against a rail that will never settle it.
 *
 * Written as deletes rather than an edit of `20260418000010` alone because
 * that migration is already applied: fixing only the seed would leave existing
 * shards carrying rows no fresh shard gets. Both statements are no-ops on a
 * shard created after the fix, so the pair is safe to run anywhere, in any
 * order, more than once.
 */
export async function up(knex: Knex): Promise<void> {
    await knex("payment_providers").where("name", "cod").del();

    if ((await resolveMigrationRegion(knex)) !== "eg") {
        await knex("payment_providers").where("name", "kashier").del();
    }
}

/**
 * Deliberately a no-op.
 *
 * A `down` that re-inserted `(2, 'cod')` and a non-`eg` `kashier` would put
 * back the rows this migration exists to remove — reintroducing the bug on a
 * shard someone stepped down for an unrelated reason. There is nothing to
 * preserve either way: no row in `transactions`, `payment_sessions` or
 * `payment_webhook_events` references them, which is why they could be deleted
 * at all.
 *
 * A full rollback still reaches `20260418000010`, whose `down` drops the table
 * outright, so no state is stranded.
 */
export async function down(): Promise<void> {
    // Intentionally empty — see above.
}
