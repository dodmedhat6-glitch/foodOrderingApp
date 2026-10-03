import { Knex } from "knex";
import { randomUUID } from "crypto";
import { OutboxEvent, OutboxStatus } from "../entity/outbox-event.entity";

const OUTBOX_COLUMNS = [
    "id", "event_id", "channel", "event_type", "entity_type", "entity_id", "payload",
    "status", "attempts", "last_error", "created_at", "published_at"
];

function toEntity(row: any): OutboxEvent {
    return new OutboxEvent({
        id: row.id,
        eventId: row.event_id,
        channel: row.channel,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: row.payload,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        createdAt: row.created_at,
        publishedAt: row.published_at
    });
}

export interface EnqueueOutboxEventInput {
    channel: string;
    eventType: string;
    entityType: string;
    entityId: number;
    payload: object;
}

/**
 * Insert a pending outbox row. Callers must pass the same `trx` they used
 * for the domain write this event describes - the whole point of the
 * outbox pattern is that the event only exists if the write it reports on
 * committed, and vice versa.
 */
export async function enqueueOutboxEvent(data: EnqueueOutboxEventInput, trx: Knex.Transaction): Promise<OutboxEvent> {
    const [row] = await trx("event_outbox").insert({
        event_id: randomUUID(),
        channel: data.channel,
        event_type: data.eventType,
        entity_type: data.entityType,
        entity_id: data.entityId,
        payload: JSON.stringify(data.payload),
        status: OutboxStatus.PENDING,
        attempts: 0,
        created_at: new Date()
    }).returning(OUTBOX_COLUMNS);

    return toEntity(row);
}

/**
 * Dispatcher claim - selects a batch of pending rows and locks them so
 * another dispatcher process (or an overlapping tick) can't pick up the
 * same rows. `trx` must be the same transaction the caller uses for the
 * publish + status update that follows; committing releases the locks,
 * and if the worker dies before committing, Postgres drops the connection
 * and releases the locks itself - the rows fall straight back to
 * claimable, no lease/heartbeat bookkeeping required.
 */
export async function claimPendingOutboxEvents(trx: Knex.Transaction, limit: number): Promise<OutboxEvent[]> {
    const rows = await trx("event_outbox")
        .select(OUTBOX_COLUMNS)
        .where("status", OutboxStatus.PENDING)
        .orderBy("created_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();

    return rows.map(toEntity);
}

export async function markOutboxEventPublished(trx: Knex.Transaction, id: number): Promise<void> {
    await trx("event_outbox").where("id", id).update({
        status: OutboxStatus.PUBLISHED,
        published_at: new Date()
    });
}

/**
 * Records a failed publish attempt. Stays `pending` (retried by the next
 * drain tick) until `maxAttempts` is reached, then flips to `failed` so the
 * worker stops hammering a permanently-broken event.
 */
export async function markOutboxEventFailed(trx: Knex.Transaction, id: number, error: string, maxAttempts: number): Promise<void> {
    await trx.raw(
        `
        UPDATE event_outbox
        SET attempts = attempts + 1,
            last_error = ?,
            status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
        WHERE id = ?
    `,
        [error.slice(0, 2000), maxAttempts, id]
    );
}
