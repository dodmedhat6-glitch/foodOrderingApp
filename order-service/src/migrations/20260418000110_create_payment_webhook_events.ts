import type {Knex} from "knex";

/**
 * `payment_webhook_events` — the raw provider webhook log
 * (docs/database-design.md s3.11).
 *
 * It does two jobs. The unique `(provider_id, provider_event_id)` is the
 * de-dup gate: a replayed delivery conflicts and is acknowledged without
 * touching money. And the row itself is the audit trail CLAUDE.md s10
 * requires of a webhook handler — `processed_at` or `process_error` is
 * stamped on every event, so a failed webhook is a row an operator can find
 * and replay rather than a line in a log that has since rotated.
 *
 * `provider_event_id` is `<transactionId>:<status>` for Kashier, which is the
 * granularity its own docs tell integrators to key on: the same transaction
 * legitimately produces more than one event as it moves PENDING -> SUCCESS,
 * and those are different facts, not duplicates.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_webhook_events (
            id                BIGSERIAL PRIMARY KEY,
            region            TEXT NOT NULL,
            provider_id       INT NOT NULL,             -- logical FK -> payment_providers.id
            provider_event_id TEXT NOT NULL,            -- de-dup key from the provider
            event_type        TEXT NOT NULL,            -- the provider's own event name ('pay', 'refund', ...)
            signature         TEXT NOT NULL,
            payload           JSONB NOT NULL,
            received_at       TIMESTAMP NOT NULL DEFAULT NOW(),
            processed_at      TIMESTAMP NULL,
            process_error     TEXT NULL,

            CONSTRAINT uq_payment_webhook_events_provider_event_id
                UNIQUE (provider_id, provider_event_id)
        );

        -- supports the operator sweep for events that arrived and never settled
        CREATE INDEX idx_payment_webhook_events_received_at ON payment_webhook_events (received_at)
            WHERE processed_at IS NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_webhook_events;`);
}
