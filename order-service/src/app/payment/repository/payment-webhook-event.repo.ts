import {Knex} from "knex";
import {CreateWebhookEventInput} from "../types";

/**
 * The raw webhook log. There is no entity for it: nothing in the service
 * reasons about a webhook row beyond "was this one new" and "record how it
 * went", so the repo returns exactly those answers rather than hydrating a
 * class nobody reads.
 */

/**
 * Records an inbound event, returning the row id when it was new and
 * `undefined` when the provider had already sent it.
 *
 * `ON CONFLICT DO NOTHING` on `(provider_id, provider_event_id)` is the
 * de-dup gate (docs/business-logic/payments.md s3). It is committed on its
 * own connection *before* the money work starts, so the record of "this
 * arrived" survives a processing failure — which is the whole point of
 * keeping the log: an event that threw is a row an operator can find, not a
 * line in a rotated log.
 */
export async function recordWebhookEvent(
    data: CreateWebhookEventInput,
    conn: Knex,
): Promise<number | undefined> {
    const [row] = await conn("payment_webhook_events")
        .insert({
            region: data.region,
            provider_id: data.providerId,
            provider_event_id: data.providerEventId,
            event_type: data.eventType,
            signature: data.signature,
            payload: JSON.stringify(data.payload),
            received_at: new Date(),
        })
        .onConflict(["provider_id", "provider_event_id"])
        .ignore()
        .returning(["id"]);

    return row ? Number(row.id) : undefined;
}

/**
 * The row behind a conflict, so the caller can tell a true duplicate from a
 * retry of something that failed.
 *
 * A conflict on the insert above does not by itself mean "done": an event
 * that arrived and then failed mid-processing leaves a row with
 * `processed_at IS NULL`, and the provider's retry of it must be allowed
 * through rather than acknowledged as a duplicate — that retry is the entire
 * reason the provider has a retry schedule.
 */
export async function findWebhookEvent(
    providerId: number,
    providerEventId: string,
    conn: Knex,
): Promise<{id: number; processedAt: Date | null} | undefined> {
    const row = await conn("payment_webhook_events")
        .select(["id", "processed_at"])
        .where("provider_id", providerId)
        .where("provider_event_id", providerEventId)
        .first();

    return row ? {id: Number(row.id), processedAt: row.processed_at} : undefined;
}

export async function markWebhookEventProcessed(eventId: number, conn: Knex): Promise<void> {
    await conn("payment_webhook_events")
        .where("id", eventId)
        .update({processed_at: new Date(), process_error: null});
}

/**
 * Stamps why an event failed. Called on a connection outside the rolled-back
 * transaction — the money work is undone, but the fact that we tried and how
 * it went must survive (CLAUDE.md s10: no silent failures in webhooks).
 */
export async function markWebhookEventFailed(
    eventId: number,
    error: string,
    conn: Knex,
): Promise<void> {
    await conn("payment_webhook_events")
        .where("id", eventId)
        .update({process_error: error.slice(0, 1000), processed_at: null});
}
