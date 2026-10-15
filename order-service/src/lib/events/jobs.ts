import {env} from "../config/env";
import {toMs} from "../../pkg/utils/time";
import {REGIONS} from "../sharding/regions";
import {register} from "../jobs/job-registry";
import {messageBroker} from "../messaging/init";
import {OutboxDrain} from "./outbox-drain";

/**
 * Registers the outbox drain with the worker's scheduler. Lives in `lib/`
 * rather than an `app/<module>/jobs.ts` because the outbox is not owned by
 * any one module: orders write to it today, payments and deliveries will.
 *
 * The scheduler's no-overlap rule matters here: a tick still publishing when
 * the next one fires is skipped, so one worker never races itself for rows.
 * Several workers racing each other is fine — that is what SKIP LOCKED is for.
 */
export function registerOutboxDrainJobs(): void {
    const drain = new OutboxDrain(messageBroker, env.outboundEvents.exchange, REGIONS);

    register({
        name: "events:outbox-drain",
        intervalMs: toMs(env.outboundEvents.drainTickSec, "s"),
        runOnStart: true,
        handler: () => drain.drainAll(env.outboundEvents.batchSize),
    });
}
