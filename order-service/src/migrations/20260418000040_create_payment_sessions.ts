import type {Knex} from "knex";

/**
 * `payment_sessions` — our mirror of a Kashier Payment Session, created before
 * the customer is redirected to the checkout and advanced by the webhook.
 *
 * Four deviations from the draft in docs/database-design.md s3.4, each forced
 * by something the provider or the partitioning actually does:
 *
 *  1. **No FK to `orders`.** The draft declares
 *     `fk_payment_sessions_order_id REFERENCES orders(id)`, which Postgres
 *     cannot create: `orders` is RANGE-partitioned and a FK into it needs a
 *     unique index containing the partition key. Same reasoning, and the same
 *     resolution, as `order_items` — a logical reference, with header and
 *     session written by services that already hold the order.
 *  2. **`order_public_id`.** A webhook names only the merchant reference, and
 *     reaching the order from `order_id` alone would mean scanning every
 *     month's partition. The public id is a UUIDv7, so holding it here lets
 *     the settle path derive a `created_at` window and prune to one partition
 *     (CLAUDE.md s7/Partitioning, consequence 2).
 *  3. **`merchant_order_ref`.** Kashier's webhook carries no session id — it
 *     identifies the payment by the `order` reference *we* chose, echoed back
 *     as `merchantOrderId`. That reference is also one of the fields the HMAC
 *     signs, so it is the one correlation handle an attacker cannot forge.
 *     It cannot simply be the order's public id: Kashier rejects a duplicate
 *     order reference per merchant (`ERR_ORD_02`), so a customer retrying a
 *     failed payment needs a fresh one. The format is
 *     `<region>_<publicId>_<attempt>` — the region because a webhook arrives
 *     with no `X-Region` header and we must pick a shard before we can look
 *     anything up.
 *  4. **`provider_order_id`.** Kashier's refund endpoint is keyed by *its*
 *     order id, which we only learn when the first webhook lands. The charge
 *     transaction keeps the transaction id; the Kashier order id belongs to
 *     the session, which is the row that represents the Kashier order.
 *
 * `expires_at` is ours too: it is what `POST /payments/init` returns to the
 * client, and the handle an expiry sweep needs.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_sessions (
            id                  BIGSERIAL PRIMARY KEY,
            region              TEXT NOT NULL,
            order_id            BIGINT NOT NULL,        -- logical FK -> orders.id (partitioned parent, see above)
            order_public_id     UUID NOT NULL,
            provider_id         INT NOT NULL,           -- logical FK -> payment_providers.id (replicated lookup)
            merchant_order_ref  TEXT NOT NULL,          -- what we send Kashier as its order ref; echoed back as merchantOrderId
            provider_session_id TEXT NOT NULL,          -- Kashier's session _id
            provider_order_id   TEXT NULL,              -- Kashier's order id, learned from the first webhook
            redirect_url        TEXT NOT NULL,
            amount              INT NOT NULL CHECK (amount > 0),    -- minor units
            currency            TEXT NOT NULL,
            status              TEXT NOT NULL CHECK (status IN (
                                    'initialized','pending','authorized','captured','failed','expired','cancelled'
                                )),
            expires_at          TIMESTAMP NOT NULL,
            raw_init_payload    JSONB NOT NULL,         -- what we sent Kashier
            raw_last_payload    JSONB NULL,             -- last webhook data block
            created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_payment_sessions_provider_session_id UNIQUE (provider_session_id),
            -- the webhook's only correlation handle, so it must resolve to exactly one session
            CONSTRAINT uq_payment_sessions_merchant_order_ref UNIQUE (merchant_order_ref)
        );

        -- supports POST /api/payments/init re-using a live session, the order
        -- detail's payment summary, and the refund path reaching provider_order_id
        CREATE INDEX idx_payment_sessions_order_id ON payment_sessions (order_id);
        -- supports the expiry sweep: open sessions whose expires_at has passed
        CREATE INDEX idx_payment_sessions_status_expires_at ON payment_sessions (status, expires_at)
            WHERE status IN ('initialized','pending','authorized');
        -- (no index on provider_session_id or merchant_order_ref: the unique
        --  constraints above already provide one each)
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_sessions;`);
}
