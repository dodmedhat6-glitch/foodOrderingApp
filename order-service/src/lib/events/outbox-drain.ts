import {db} from "../knex/knex";
import {logger} from "../logger/logger";
import {IMessageBroker} from "../../pkg/messaging/message-broker.interface";
import {claimPendingOutboxEvents, markOutboxEventFailed, markOutboxEventsPublished} from "./outbox.repo";
import {DrainResult, OutboundEventEnvelope, OutboxEvent} from "./types";

/**
 * Attempts before a row stops being retried and is parked as `failed`. Same
 * budget as core's drain: at a 2s tick that is ~10s of a sick broker, after
 * which an operator — not a hot loop — decides what happens next.
 */
const MAX_ATTEMPTS = 5;

/**
 * The other half of the transactional outbox: polled by the worker
 * (jobs.ts), it gets committed `events_outbox` rows onto `order.events` and
 * marks them done. Keeping it out of the request path means a broker blip
 * never fails an order and never loses its event — it only delays it.
 *
 * Same shape as core's `OutboxDrainService`, with one difference: there is
 * no single outbox here. Every shard owns its own, so a tick walks every
 * region and drains each in its own transaction on its own connection.
 */
export class OutboxDrain {
    constructor(
        private readonly broker: IMessageBroker,
        private readonly exchange: string,
        private readonly regions: ReadonlyArray<string>,
    ) {}

    /**
     * One tick across every region. A region that fails — shard down, broker
     * down — is logged and skipped; the others still drain, and the failed
     * one's rows are still `pending` for the next tick.
     */
    drainAll = async (batchSize: number): Promise<DrainResult[]> => {
        const results: DrainResult[] = [];
        for (const region of this.regions) {
            try {
                const result = await this.drainRegion(region, batchSize);
                results.push(result);
                if (result.published > 0 || result.failed > 0) {
                    logger.info("outbox drain tick", {...result});
                }
            } catch (err) {
                logger.error("outbox drain failed", {region, error: (err as Error).message});
            }
        }
        return results;
    };

    /**
     * Claim, publish and mark inside one transaction. The claim's row locks
     * keep a second worker off these rows; committing only after the batch
     * is handled is what makes a crash harmless — the transaction never
     * commits, Postgres drops the locks with the connection, and the rows are
     * claimable again on the next tick.
     *
     * The cost of that is at-least-once: a crash *after* a publish but
     * before the commit republishes the row. Consumers dedupe on `eventId`.
     */
    drainRegion = async (region: string, batchSize: number): Promise<DrainResult> => {
        let failed = 0;
        const publishedIds: number[] = [];

        const trx = await db(region).transaction();
        try {
            const events = await claimPendingOutboxEvents(trx, batchSize);

            for (const event of events) {
                try {
                    await this.broker.publish(
                        this.exchange,
                        event.eventType,
                        Buffer.from(JSON.stringify(toEnvelope(event)), "utf8"),
                    );
                    publishedIds.push(event.id);
                } catch (err) {
                    // The broker is sick. Stop working the batch rather than
                    // timing out row by row while holding every lock in it.
                    await markOutboxEventFailed(trx, event.id, describeError(err), MAX_ATTEMPTS);
                    failed++;
                    break;
                }
            }

            await markOutboxEventsPublished(trx, publishedIds);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        return {region, published: publishedIds.length, failed};
    };
}

function toEnvelope(event: OutboxEvent): OutboundEventEnvelope {
    return {
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: new Date(event.createdAt).toISOString(),
        entityType: event.entityType,
        entityId: event.entityId,
        payload: event.payload,
    };
}

function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
