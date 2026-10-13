import {Knex} from "knex";
import {randomUUID} from "crypto";
import {EnqueueOutboxEventInput, OutboxEvent, OutboxStatus} from "./types";

const OUTBOX_COLUMNS = [
    "id",
    "event_id",
    "event_type",
    "entity_type",
    "entity_id",
    "payload",
    "status",
    "attempts",
    "last_error",
    "created_at",
    "published_at",
];

function toEntity(row: any): OutboxEvent {
    return {
        id: Number(row.id),
        eventId: row.event_id,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: row.payload,
        status: row.status as OutboxStatus,
        attempts: row.attempts,
        lastError: row.last_error,
        createdAt: row.created_at,
        publishedAt: row.published_at,
    };
}

/**
 * Insert a pending outbox row. `trx` must be the transaction that performs
 * the domain write this event describes — the whole point of the outbox is
 * that the event exists if and only if that write committed. It is on the
 * right shard by construction: the row lives wherever the order does.
 */
export async function enqueueOutboxEvent(data: EnqueueOutboxEventInput, trx: Knex): Promise<OutboxEvent> {
    const [row] = await trx("events_outbox")
        .insert({
            event_id: randomUUID(),
            event_type: data.eventType,
            entity_type: data.entityType,
            entity_id: data.entityId,
            payload: JSON.stringify(data.payload),
            status: OutboxStatus.PENDING,
            attempts: 0,
            created_at: new Date(),
        })
        .returning(OUTBOX_COLUMNS);

    return toEntity(row);
}

/**
 * The drain's claim — backed by idx_events_outbox_created_at_pending.
 *
 * FOR UPDATE SKIP LOCKED is what makes N workers per region safe: a second
 * worker's claim skips the rows this one holds instead of waiting on them or
 * publishing them twice. `trx` must be the transaction the caller publishes
 * and marks inside; committing releases the locks, and a worker that dies
 * mid-batch loses its connection, which releases them too — the rows fall
 * straight back to claimable with no lease bookkeeping.
 */
export async function claimPendingOutboxEvents(trx: Knex.Transaction, limit: number): Promise<OutboxEvent[]> {
    const rows = await trx("events_outbox")
        .select(OUTBOX_COLUMNS)
        .where("status", OutboxStatus.PENDING)
        .orderBy("created_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();

    return rows.map(toEntity);
}

/** One UPDATE for every row the batch published, not one per row. */
export async function markOutboxEventsPublished(trx: Knex.Transaction, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await trx("events_outbox").whereIn("id", ids).update({
        status: OutboxStatus.PUBLISHED,
        published_at: new Date(),
    });
}

/**
 * Records a failed publish. The row stays `pending` (the next tick retries
 * it) until `maxAttempts`, then flips to `failed` so the worker stops
 * hammering an event that will never go — an operator replays it by setting
 * it back to `pending`.
 */
export async function markOutboxEventFailed(
    trx: Knex.Transaction,
    id: number,
    error: string,
    maxAttempts: number,
): Promise<void> {
    await trx.raw(
        `
        UPDATE events_outbox
        SET attempts   = attempts + 1,
            last_error = ?,
            status     = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
        WHERE id = ?
        `,
        [error.slice(0, 2000), maxAttempts, id],
    );
}
