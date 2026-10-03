import type {Knex} from "knex";
import {db} from "../knex/knex";
import {logger} from "../logger/logger";
import {REGIONS} from "../sharding/regions";

/**
 * Native partition maintenance for `orders`.
 *
 * We partition declaratively rather than with pg_partman: the extension has no
 * build for Postgres 18 on Windows, and the only thing we need from it is
 * "keep a rolling window of month partitions", which is a dozen lines of SQL.
 * That also keeps partitioning reproducible from migrations alone, with no
 * superuser CREATE EXTENSION step in CI.
 *
 * Runs at boot and daily thereafter. Idempotent: creating a partition that
 * already exists is a no-op, so a missed run self-heals on the next tick, and
 * the DEFAULT partition catches anything that slips through in between.
 */

// How far ahead to keep partitions pre-created. A month of runway means a
// stalled scheduler never reaches the DEFAULT partition.
const MONTHS_AHEAD = 3;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PartitionMaintenanceResult {
    region: string;
    created: string[];
    defaultRowCount: number;
}

function monthStart(year: number, monthIndex0: number): Date {
    return new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0, 0));
}

function partitionNameFor(from: Date): string {
    const yyyy = from.getUTCFullYear();
    const mm = String(from.getUTCMonth() + 1).padStart(2, "0");
    return `orders_${yyyy}${mm}`;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/**
 * Creates every missing month partition from the current month through
 * `monthsAhead`, and reports how many rows ended up in the DEFAULT partition
 * (always expected to be 0 — a non-zero count means maintenance stopped
 * running long enough for writes to fall through).
 */
export async function ensureOrderPartitions(
    conn: Knex,
    region: string,
    monthsAhead: number = MONTHS_AHEAD,
): Promise<PartitionMaintenanceResult> {
    const created: string[] = [];
    const now = new Date();

    for (let offset = 0; offset <= monthsAhead; offset++) {
        const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() + offset);
        const to = monthStart(from.getUTCFullYear(), from.getUTCMonth() + 1);
        const name = partitionNameFor(from);

        const exists = await conn
            .select(conn.raw("1"))
            .from("pg_class")
            .where("relname", name)
            .first();
        if (exists) continue;

        // Bounds are interpolated, not bound: Postgres does not accept bind
        // parameters in DDL, so `FOR VALUES FROM (?)` arrives as `FROM ($1)`
        // and is rejected outright. Safe to inline here because both values
        // come from `isoDate(monthStart(...))` — a YYYY-MM-DD string built from
        // a Date this function computed, never from a request. `??` stays bound
        // since knex interpolates identifiers itself.
        await conn.raw(
            `CREATE TABLE IF NOT EXISTS ?? PARTITION OF orders
             FOR VALUES FROM ('${isoDate(from)}') TO ('${isoDate(to)}');`,
            [name],
        );
        created.push(name);
    }

    const [{count}] = (await conn.raw(`SELECT COUNT(*)::int AS count FROM orders_default;`)).rows;

    return {region, created, defaultRowCount: count};
}

export async function runPartitionMaintenance(): Promise<PartitionMaintenanceResult[]> {
    const results: PartitionMaintenanceResult[] = [];

    for (const region of REGIONS) {
        try {
            const result = await ensureOrderPartitions(db(region), region);
            results.push(result);
            if (result.created.length > 0) {
                logger.info("order partitions created", {region, partitions: result.created});
            }
            if (result.defaultRowCount > 0) {
                logger.warn("orders_default is not empty — partition maintenance fell behind", {
                    region,
                    rows: result.defaultRowCount,
                });
            }
        } catch (err) {
            // One unreachable shard must not stop the others.
            logger.error("partition maintenance failed", {region, error: (err as Error).message});
        }
    }

    return results;
}

export function startPartitionMaintenance(): NodeJS.Timeout {
    void runPartitionMaintenance();
    const timer = setInterval(() => void runPartitionMaintenance(), RUN_INTERVAL_MS);
    timer.unref();
    return timer;
}
