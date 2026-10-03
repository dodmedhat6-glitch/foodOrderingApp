import "reflect-metadata";
import { db } from "./lib/knex/kenx";
import { messageBroker } from "./lib/message-broker/init";
import { env } from "./lib/config/env";
import { OutboxDrainService } from "./app/outbox/service/outbox-drain.service";
import { logger } from "./lib/logger/logger";

const POLL_INTERVAL_MS = 2000;

const drainService = new OutboxDrainService(messageBroker, env.rabbit.exchange);
let stopped = false;

async function loop() {
    while (!stopped) {
        try {
            const result = await drainService.drainOnce(env.rabbit.batchSize);
            if (result.published > 0 || result.failed > 0) {
                logger.info("outbox drain tick", { published: result.published, failed: result.failed });
            }
        } catch (error) {
            logger.error("outbox drain tick failed", { error: String(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function start() {
    await messageBroker.connect();
    await messageBroker.declareExchange(env.rabbit.exchange);
    logger.info("outbox worker starting", { pollIntervalMs: POLL_INTERVAL_MS, exchange: env.rabbit.exchange });
    await loop();
}

start().catch((error) => {
    logger.error("outbox worker failed to start", { error: String(error) });
    process.exit(1);
});

async function shutdown() {
    logger.info("outbox worker shutting down...");
    stopped = true;
    // here we need to wait the loop ending before shutdown
    await messageBroker.close();
    await db.destroy();
    logger.info("outbox worker shut down");
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
