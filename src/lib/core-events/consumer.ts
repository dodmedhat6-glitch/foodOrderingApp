import {randomUUID} from "crypto";
import {IMessageBroker, ConsumeMessage} from "../../pkg/messaging/message-broker.interface";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {getHandler} from "./registry";
import {CoreEventEnvelope, CoreEventMeta} from "./types";

/**
 * Transport for the inbound core-event stream, and nothing else: topology,
 * dedupe, dispatch, ack/nack. What an event *means* lives in handlers/, and
 * what it *does* lives in the services those delegate to.
 *
 * Safety window for redelivery (consumer restart, nack-requeue, ops DLQ
 * replay). Longer than realistic redelivery lag, short enough to keep Redis
 * bounded. Safe to expire because every handler is idempotent.
 */
const DEDUPE_TTL_SEC = 24 * 60 * 60;

const topology = {
    exchange: env.rabbit.exchange,
    queue: env.rabbit.queue,
    bindingKeys: env.rabbit.bindings,
    deadLetterExchange: env.rabbit.dlx,
    deadLetterQueue: env.rabbit.dlq,
    prefetch: env.rabbit.prefetch,
};

export async function startCoreEventsConsumer(broker: IMessageBroker): Promise<void> {
    await broker.declareTopology(topology);
    await broker.consume(topology, handleMessage);
    logger.info("core-events consumer started", {
        queue: env.rabbit.queue,
        bindings: env.rabbit.bindings,
    });
}

async function handleMessage(msg: ConsumeMessage): Promise<void> {
    const envelope = parseEnvelope(msg);
    if (!envelope) return msg.nack(false);

    // Dedupe via Redis SETNX. Returns false if we've already processed this
    // eventId: delivery is at-least-once, so duplicates are expected, not
    // exceptional.
    const fresh = await cacheProvider.trySet(
        `core-events:dedupe:${envelope.eventId}`,
        "1",
        DEDUPE_TTL_SEC,
    );
    if (!fresh) {
        msg.ack();
        return;
    }

    const handler = getHandler(envelope.eventType);
    if (!handler) {
        logger.warn("core-events: no handler, acking", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
        });
        msg.ack();
        return;
    }

    try {
        await handler(envelope.payload, metaOf(envelope));
        msg.ack();
    } catch (err) {
        logger.error("core-events: handler failed, sending to DLQ", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
            error: (err as Error).message,
        });
        msg.nack(false);
    }
}

/**
 * The envelope metadata handed to the handler. `correlationId` falls back to
 * the eventId so that any log line or outbound core call a handler causes is
 * attributable to a specific delivery even when core sent no correlation of
 * its own.
 */
export function metaOf(envelope: CoreEventEnvelope): CoreEventMeta {
    return {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        occurredAt: envelope.occurredAt,
        correlationId: envelope.correlationId ?? envelope.eventId ?? randomUUID(),
    };
}

function parseEnvelope(msg: ConsumeMessage): CoreEventEnvelope | null {
    try {
        const parsed = JSON.parse(msg.body.toString("utf8")) as CoreEventEnvelope;
        if (!parsed.eventId || !parsed.eventType) return null;
        return parsed;
    } catch {
        return null;
    }
}
