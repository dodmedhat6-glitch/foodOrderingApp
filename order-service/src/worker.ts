import "reflect-metadata";
import http from "http";
import {logger} from "./lib/logger/logger";
import {destroyAll, pingAll} from "./lib/knex/knex";
import {attachWsServer} from "./lib/websocket/ws-server";
import {container} from "./lib/di/container";
import {TOKENS} from "./lib/di/tokens";
import {startAll, stopAll} from "./lib/jobs/scheduler";
import {registerOrderJobs} from "./app/order/jobs";
import {registerPaymentJobs} from "./app/payment/jobs";
import {registerDeliveryJobs} from "./app/delivery/jobs";
import {registerAgentJobs} from "./app/agent/jobs";
import {registerArchivalJobs} from "./app/archival/jobs";
import {registerOutboxDrainJobs} from "./lib/events/jobs";
import {messageBroker} from "./lib/messaging/init";
import {env} from "./lib/config/env";

/**
 * Background worker process. Boots the shared infra and hands control to the
 * scheduler; it serves no HTTP and consumes no core events (the API process
 * does, and the cache it corrects is shared in Redis).
 *
 * Kept apart from `server.ts` so the API can scale to N replicas without
 * running N copies of every sweep. Adding a job means: `register({...})` in
 * the owning module's `jobs.ts`, then one line below.
 */

// The assignment sweep pushes offers over WebSocket. socket.io needs an
// http.Server to attach to; it never receives a request — the Redis adapter
// fans the emit out to the API processes that hold the sockets.
const noopServer = http.createServer();
const io = attachWsServer(noopServer);
container.registerInstance(TOKENS.WsServer, io);

// ── Job registrations ───────────────────────────────────────────────────
registerOrderJobs();
registerPaymentJobs();
registerDeliveryJobs();
registerAgentJobs();
registerArchivalJobs();
registerOutboxDrainJobs();

async function main() {
    noopServer.listen(0);

    // Not awaited: `connect()` only resolves once the broker answers, and
    // amqp-connection-manager retries forever, so awaiting it here would keep
    // every other job from starting while RabbitMQ is down. The drain's
    // publishes time out instead (publishTimeoutMs), leaving rows `pending`.
    messageBroker
        .declareExchange(env.outboundEvents.exchange)
        .then(() => logger.info("order events exchange declared", {exchange: env.outboundEvents.exchange}))
        .catch((err) => logger.warn("rabbitmq not reachable at boot — will retry", {error: (err as Error).message}));

    // Every job touches every shard, so check them before the first tick.
    const shards = await pingAll();
    for (const r of shards) {
        if (r.ok) logger.info("worker shard reachable", {region: r.region, cluster: r.cluster});
        else logger.warn("worker shard unreachable", {region: r.region, cluster: r.cluster, error: r.error});
    }

    startAll();
    logger.info("order-service worker started");
}

async function shutdown() {
    logger.info("worker shutdown requested");
    setTimeout(() => process.exit(1), 10_000).unref();
    await stopAll();
    try {
        await io.close();
    } catch {}
    // After stopAll: no drain tick is mid-publish once the jobs have settled.
    try {
        await messageBroker.close();
    } catch (err) {
        logger.warn("broker close error", {error: (err as Error).message});
    }
    try {
        await destroyAll();
    } catch (err) {
        logger.warn("db destroy error", {error: (err as Error).message});
    }
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
    logger.error("worker boot failed", {error: (err as Error).message});
    process.exit(1);
});
