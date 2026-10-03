import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        ALTER TABLE event_outbox
            ADD COLUMN event_id UUID NOT NULL DEFAULT gen_random_uuid();

        CREATE UNIQUE INDEX idx_event_outbox_event_id ON event_outbox(event_id);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP INDEX IF EXISTS idx_event_outbox_event_id;
        ALTER TABLE event_outbox DROP COLUMN IF EXISTS event_id;
    `);
}
