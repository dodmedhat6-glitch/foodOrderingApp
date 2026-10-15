import {logger} from "../logger/logger";
import {listJobs} from "./job-registry";

/**
 * Runs every registered job on its interval.
 *
 * - **No overlap.** If a tick is still running when the next fires, the new
 *   one is skipped. A sweep that takes longer than its interval would
 *   otherwise stack up copies of itself against the same rows.
 * - **Isolation.** A handler that throws is logged; the next tick still runs.
 * - **Clean shutdown.** `stopAll` clears the timers and waits for in-flight
 *   ticks, so the worker does not destroy the knex pools under a running query.
 *
 * Plain `setInterval` rather than cron: every job here is "every N seconds",
 * and none needs wall-clock scheduling.
 */

const timers: NodeJS.Timeout[] = [];
const inFlight = new Map<string, Promise<void>>();

function tick(name: string, handler: () => Promise<unknown>): void {
    if (inFlight.has(name)) {
        logger.debug("job skipped (previous tick still running)", {job: name});
        return;
    }

    const start = Date.now();
    const run = handler()
        .then(() => undefined)
        .catch((err) => {
            logger.error("job failed", {job: name, error: (err as Error).message});
        })
        .finally(() => {
            inFlight.delete(name);
            logger.debug("job tick", {job: name, ms: Date.now() - start});
        });
    inFlight.set(name, run);
}

export function startAll(): void {
    for (const job of listJobs()) {
        if (job.runOnStart) tick(job.name, job.handler);
        timers.push(setInterval(() => tick(job.name, job.handler), job.intervalMs));
        logger.info("job scheduled", {job: job.name, everyMs: job.intervalMs});
    }
}

export async function stopAll(): Promise<void> {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    await Promise.allSettled(inFlight.values());
}
