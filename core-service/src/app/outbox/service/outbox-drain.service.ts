import { db } from "../../../lib/knex/kenx";
import { IMessageBroker } from "../../../pkg/message-broker/message-broker.interface";
import { claimPendingOutboxEvents, markOutboxEventFailed, markOutboxEventPublished } from "../repository/outbox.repo";

const DEFAULT_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

export interface DrainResult {
    published: number;
    failed: number;
}

/**
 * Transactional-outbox drain: the write and the outbox row commit together
 * (see repository/outbox.repo.ts `enqueueOutboxEvent`); this class is the
 * other half - polled by worker.ts - that actually gets the row onto the
 * message broker and marks it done. Keeping this out of the request path
 * means a broker blip never loses an event, only delays it.
 *
 * Claim, publish, and mark all happen inside one transaction. The claim's
 * row locks (FOR UPDATE SKIP LOCKED) are what keeps two worker instances
 * from double-publishing the same row, and committing only after every row
 * in the batch is handled is what makes crash recovery automatic: if this
 * process dies mid-batch, the transaction never commits, Postgres releases
 * the locks the moment the connection drops, and the claimed rows fall
 * straight back to `pending` for the next tick - no separate lease/heartbeat
 * mechanism needed.
 */
export class OutboxDrainService {
    constructor(private readonly broker: IMessageBroker, private readonly exchange: string) {}

    async drainOnce(batchSize: number = DEFAULT_BATCH_SIZE): Promise<DrainResult> {
        let published = 0;
        let failed = 0;

        const trx = await db.transaction();
        try {
            const events = await claimPendingOutboxEvents(trx, batchSize);

            for (const event of events) {
                const envelope = {
                    eventId: event.eventId,
                    eventType: event.eventType,
                    occurredAt: new Date().toISOString(),
                    entityType: event.entityType,
                    entityId: event.entityId,
                    payload: event.payload,
                };

                try {
                    await this.broker.publishConfirmed(
                        this.exchange,
                        event.eventType,
                        Buffer.from(JSON.stringify(envelope), "utf8"),
                    );
                    await markOutboxEventPublished(trx, event.id);
                    published++;
                } catch (err) {
                    // Broker is probably unhealthy - stop working the rest of the
                    // batch rather than hammering it row by row.
                    await markOutboxEventFailed(trx, event.id, describeError(err), MAX_ATTEMPTS);
                    failed++;
                    break;
                }
            }
            // bulk update for dispatched and bulk updated for failed
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        return { published, failed };
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    if (err && typeof err === "object" && "errors" in err) {
        const inner = (err as { errors: unknown[] }).errors;
        if (Array.isArray(inner) && inner.length > 0) {
            return inner.map(describeError).filter(Boolean).join("; ");
        }
    }
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
