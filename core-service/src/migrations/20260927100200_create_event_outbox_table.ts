import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TYPE outbox_status AS ENUM('pending', 'published', 'failed');

        CREATE TABLE event_outbox (
            id BIGSERIAL PRIMARY KEY,
            channel TEXT NOT NULL,
            event_type TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id BIGINT NOT NULL,
            payload JSONB NOT NULL,
            status outbox_status NOT NULL DEFAULT 'pending',
            attempts SMALLINT NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TIMESTAMP NOT NULL,
            published_at TIMESTAMP
        );

        -- GET pending batch for the outbox drain worker (worker.ts)
        CREATE INDEX idx_event_outbox_status_created ON event_outbox(status, created_at);
        CREATE INDEX idx_event_outbox_entity ON event_outbox(entity_type, entity_id);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP TABLE IF EXISTS event_outbox;
        DROP TYPE IF EXISTS outbox_status;
    `);
}
