import type {Knex} from "knex";

/**
 * `agent_earnings` — what a delivery agent earned, one row per delivered
 * order (docs/database-design.md s3.9).
 *
 * Written inside the settlement transaction that moves an order to
 * `delivered`. Four things about this table are load-bearing:
 *
 *  1. **`uq_agent_earnings_order_id` is the idempotency guard.** Settlement
 *     is reachable twice — a retried PATCH, a replayed request — and this
 *     constraint is what makes the second one a no-op instead of a second
 *     payout. Writers must use `ON CONFLICT DO NOTHING`, never a try/catch:
 *     inside a transaction a constraint violation aborts every statement
 *     after it (CLAUDE.md s8).
 *  2. **No FK to `orders`.** `orders` is RANGE-partitioned with PK
 *     `(id, created_at)`, so a child can only reference it by carrying the
 *     partition key. The reference is logical; both rows are written in the
 *     same service transaction, exactly like `order_items`.
 *  3. **`order_public_id` is denormalised.** `GET /api/agents/earnings`
 *     returns the public id on every row. Without this column a month of
 *     earnings would be a month of cross-partition lookups into `orders` —
 *     and would stop resolving at all once Phase 5 archives those rows out of
 *     the hot cluster. The id is immutable, so there is nothing to keep in
 *     sync.
 *  4. **`amount` is stamped, never recomputed.** It is
 *     `AGENT_EARNING_BASE_MINOR + AGENT_EARNING_PER_KM_MINOR x km` evaluated
 *     at settlement. Deriving it on read would let a rate change restate last
 *     month's earnings, which is a thing an agent would notice.
 *
 * There is no `delivery_id`: a delivery is a phase of an order, not a row
 * beside it (docs/database-design.md s3.7).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE agent_earnings (
            id              BIGSERIAL PRIMARY KEY,
            region          TEXT NOT NULL,
            agent_id        BIGINT NOT NULL,            -- logical FK -> core.users.id
            order_id        BIGINT NOT NULL,            -- logical FK -> orders.id (partitioned; see header)
            order_public_id UUID NOT NULL,              -- denormalised: the agent-facing order handle
            amount          INT NOT NULL CHECK (amount >= 0),   -- minor units
            currency        TEXT NOT NULL,
            distance_meters INT NULL,                   -- straight-line branch -> dropoff, as priced
            earned_at       TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_agent_earnings_order_id UNIQUE (order_id)
        );

        -- supports GET /api/agents/earnings?from=&to= — the list and the SUM
        -- over the range both run off this one index
        CREATE INDEX idx_agent_earnings_agent_earned_at ON agent_earnings (agent_id, earned_at DESC);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS agent_earnings;`);
}
