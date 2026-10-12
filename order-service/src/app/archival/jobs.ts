import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {env} from "../../lib/config/env";
import {db} from "../../lib/knex/knex";
import {logger} from "../../lib/logger/logger";
import {REGIONS} from "../../lib/sharding/regions";
import {register} from "../../lib/jobs/job-registry";
import {deleteExpired} from "../../lib/idempotency/idempotency-store";
import {toMs} from "../../pkg/utils/time";
import type {ArchivalService} from "./service/archival.service";
import type {ArchivalRunResult} from "./types";

/**
 * Whether `now` falls in the nightly window `[start, end)`, local hours. A
 * window that wraps midnight (`start > end`, e.g. 22 -> 4) is supported.
 */
export function inArchivalWindow(now: Date = new Date()): boolean {
    const {windowStartHour: start, windowEndHour: end} = env.archival;
    const hour = now.getHours();
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Moves prior-year rows to the archive cluster, every region in turn.
 *
 * The scheduler only knows intervals, so the job wakes every
 * `ARCHIVAL_INTERVAL_SEC` and does nothing outside the nightly window. Inside
 * it, a run that finds nothing to move costs one indexed query per region, so
 * waking more than once a night is harmless — and a night cut short by the
 * runtime cap simply resumes on the next tick inside the window.
 *
 * `force` skips the window check; it is what `scripts/archive-now.ts` passes.
 */
export async function runArchival(force = false): Promise<ArchivalRunResult[]> {
    if (!force && !inArchivalWindow()) return [];

    const archival = container.resolve<ArchivalService>(TOKENS.ArchivalService);
    const results: ArchivalRunResult[] = [];
    for (const region of REGIONS) {
        try {
            const result = await archival.archiveRegion(region);
            if (result) results.push(result);
        } catch (err) {
            // One unreachable shard (or archive) must not stop the others.
            logger.error("archival failed", {region, error: (err as Error).message});
        }
    }
    return results;
}

/**
 * Purges lapsed rows from `idempotency_keys`.
 *
 * Every strictly-idempotent write leaves a row with a 24h `expires_at`.
 * Nothing reads them after expiry, but until this job nothing deleted them
 * either, so the table grew with every order ever placed. Batched (see
 * `deleteExpired`) so a backlog never becomes one long DELETE on the hot path.
 */
export async function runIdempotencyPurge(): Promise<number> {
    let purged = 0;
    for (const region of REGIONS) {
        try {
            purged += await deleteExpired(db(region));
        } catch (err) {
            logger.error("idempotency purge failed", {region, error: (err as Error).message});
        }
    }
    if (purged > 0) logger.info("idempotency keys purged", {purged});
    return purged;
}

export function registerArchivalJobs(): void {
    register({
        name: "archival:nightly",
        intervalMs: toMs(env.archival.intervalSec, "s"),
        runOnStart: true,
        handler: () => runArchival(),
    });
    register({
        name: "idempotency:purge-expired",
        intervalMs: toMs(env.archival.idempotencyPurgeIntervalSec, "s"),
        runOnStart: true,
        handler: runIdempotencyPurge,
    });
}
