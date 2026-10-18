import type {Knex} from "knex";

/**
 * `events_outbox` — the transactional outbox for this service's outbound
 * events (exchange `order.events`; first consumer: analytics-service).
 *
 * Same pattern as core's `event_outbox`: the domain write and the outbox row
 * commit in one transaction, and `lib/events/outbox-drain.ts` gets the row
 * onto RabbitMQ afterwards. A broker outage therefore delays an event and
 * never loses one, and an event can never describe a write that rolled back.
 *
 * Per shard, and deliberately **without** the `region` column every other
 * sharded table carries (CLAUDE.md s7). Each shard drains its own outbox over
 * its own connection, so the region is implied by which connection read the
 * row; storing it would be a second copy that could only ever disagree. The
 * region a consumer needs travels inside the payload instead.
 *
 * `entity_id` is TEXT, not BIGINT as in core: the entity is an order and the
 * only order id that leaves this service is its UUIDv7 public id.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE events_outbox (
            id            BIGSERIAL PRIMARY KEY,
            event_id      UUID NOT NULL,                -- consumers dedupe on this
            event_type    TEXT NOT NULL,                -- also the AMQP routing key
            entity_type   TEXT NOT NULL,
            entity_id     TEXT NOT NULL,                -- order public id
            payload       JSONB NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'published', 'failed')),
            attempts      SMALLINT NOT NULL DEFAULT 0,
            last_error    TEXT NULL,
            created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
            published_at  TIMESTAMP NULL,

            CONSTRAINT uq_events_outbox_event_id UNIQUE (event_id)
        );

        -- supports the drain's claim: WHERE status = 'pending' ORDER BY created_at
        -- (lib/events/outbox.repo.ts claimPendingOutboxEvents). Partial, so
        -- published rows - nearly all of them - never enter the index.
        CREATE INDEX idx_events_outbox_created_at_pending ON events_outbox (created_at)
            WHERE status = 'pending';
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS events_outbox;`);
}
