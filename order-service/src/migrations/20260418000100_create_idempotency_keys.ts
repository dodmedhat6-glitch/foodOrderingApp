import type {Knex} from "knex";

/**
 * `idempotency_keys` — durable backing for the idempotency middleware.
 *
 * Redis serves the hot path; this table is the source of truth when Redis is
 * lost or evicts the key, which matters because the paths it guards
 * (POST /api/orders, POST /api/payments/init) cost money. The stored
 * request_fingerprint is what lets us tell a legitimate retry (same key, same
 * body -> replay the original response) from a client bug (same key,
 * different body -> 409).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE idempotency_keys (
            key_hash            BYTEA PRIMARY KEY,        -- sha256(method + path + Idempotency-Key)
            region              TEXT NOT NULL,
            user_id             BIGINT NOT NULL,          -- logical FK -> core.users.id
            request_fingerprint BYTEA NOT NULL,           -- sha256(request body)
            response_status     INT NOT NULL,
            response_body       JSONB NOT NULL,
            created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
            expires_at          TIMESTAMP NOT NULL        -- 24h after created_at
        );

        -- supports the expired-key cleanup sweep
        CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS idempotency_keys;`);
}
