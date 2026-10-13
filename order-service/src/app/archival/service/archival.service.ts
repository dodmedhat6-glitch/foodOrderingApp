import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {db, dbArchive} from "../../../lib/knex/knex";
import {archiveBoundary} from "../../../lib/knex/archive-boundary";
import {logger} from "../../../lib/logger/logger";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {toMs} from "../../../pkg/utils/time";
import {
    deleteByIds,
    deleteByOrderIds,
    deleteOrders,
    ensureArchivePartition,
    findArchivableOrders,
    insertRows,
    ORDER_CHILD_TABLES,
    readTableColumns,
    selectByOrderIds,
    selectOrderlessTransactions,
    selectOrders,
    selectWebhookEvents,
} from "../repository/archival.repo";
import {ArchivableOrderRef, ArchivalRunResult, ArchivedTable, ArchiveRegionOptions, TableColumns} from "../types";
import {StragglerRowError} from "../errors";

/**
 * Moves prior-year data from a region's hot shard to its archive twin
 * (docs/implementation-plan.md Phase 5, CLAUDE.md s7/Archival).
 *
 * **Order-driven, not table-driven.** The plan sketched one pass per table by
 * `created_at`, but a refund created in January against a December order would
 * then stay hot while its charge and order went cold — splitting one order's
 * ledger across two clusters. Instead each batch is a set of finished orders,
 * and everything keyed to them (`order_items`, `payment_sessions`,
 * `transactions`, `agent_earnings`) moves with them. Rows that name no order —
 * payouts, webhook audit events — follow by their own timestamp afterwards.
 *
 * **Archive commits first, hot deletes second.** A crash between the two leaves
 * the rows in both clusters, never in neither; the next run re-copies them as
 * `ON CONFLICT DO NOTHING` no-ops and then deletes. Readers de-duplicate by id
 * for the same window (OrderService.readAcross).
 *
 * **The delete proves itself.** Children are deleted by `order_id` with
 * `RETURNING id`, and if anything comes back that was not in the copy — a row
 * written to a finished order after it was read — the hot transaction rolls
 * back and the batch is retried, now including that row.
 *
 * One run per region at a time, across every worker process: a Redis lock
 * (`archival:<region>:lock`) whose TTL outlives the runtime cap.
 */
@injectable()
export class ArchivalService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    archiveRegion = async (
        region: string,
        options: ArchiveRegionOptions = {},
    ): Promise<ArchivalRunResult | undefined> => {
        const maxRuntimeMs = options.maxRuntimeMs ?? toMs(env.archival.maxRuntimeMin, "m");
        const lockKey = `archival:${region}:lock`;
        const lockTtlSec = Math.ceil(maxRuntimeMs / 1000) + 300;

        if (!(await this.cache.trySet(lockKey, String(process.pid), lockTtlSec))) {
            logger.info("archival skipped: another run holds the region lock", {region});
            return undefined;
        }

        try {
            return await this.run(region, options, maxRuntimeMs);
        } finally {
            await this.cache.del(lockKey).catch(() => undefined);
        }
    };

    private run = async (
        region: string,
        options: ArchiveRegionOptions,
        maxRuntimeMs: number,
    ): Promise<ArchivalRunResult> => {
        const started = Date.now();
        const deadline = started + maxRuntimeMs;
        const batchSize = options.batchSize ?? env.archival.batchSize;
        const boundary = archiveBoundary(options.now);
        const hot = db(region);
        const archive = dbArchive(region);

        const columns = await this.discoverColumns(hot);
        const result: ArchivalRunResult = {
            region,
            boundary: boundary.toISOString(),
            orders: 0,
            rowsByTable: {},
            batches: 0,
            stoppedEarly: false,
            ms: 0,
        };
        const tally = (table: string, n: number) => {
            result.rowsByTable[table] = (result.rowsByTable[table] ?? 0) + n;
        };

        // 1. Finished orders and everything keyed to them.
        let stragglerRetries = 0;
        while (Date.now() < deadline) {
            const refs = await findArchivableOrders(boundary, batchSize, hot);
            if (refs.length === 0) break;

            const batchStart = Date.now();
            try {
                const moved = await this.moveOrderBatch(refs, boundary, columns, hot, archive);
                for (const [table, n] of Object.entries(moved)) tally(table, n);
                result.orders += refs.length;
                result.batches++;
                stragglerRetries = 0;
                logger.info("archival batch moved", {region, ...moved, ms: Date.now() - batchStart});
            } catch (err) {
                if (!(err instanceof StragglerRowError) || ++stragglerRetries > 3) throw err;
                logger.warn("archival batch retried: a row was written to a finished order mid-batch", {
                    region,
                    error: err.message,
                });
            }
        }

        // 2. Ledger rows with no order (payouts), then 3. webhook audit rows.
        tally("transactions", await this.moveByTime("transactions", boundary, batchSize, deadline, columns, hot, archive, region));
        tally(
            "payment_webhook_events",
            await this.moveByTime("payment_webhook_events", boundary, batchSize, deadline, columns, hot, archive, region),
        );

        result.stoppedEarly = Date.now() >= deadline;
        result.ms = Date.now() - started;
        logger.info("archival run finished", {...result});
        return result;
    };

    /** One batch of orders: copy into the archive, commit, then delete from hot. */
    private moveOrderBatch = async (
        refs: ArchivableOrderRef[],
        boundary: Date,
        columns: Map<ArchivedTable, TableColumns>,
        hot: Knex,
        archive: Knex,
    ): Promise<Record<string, number>> => {
        const orderIds = refs.map((r) => r.id);
        const orders = await selectOrders(orderIds, boundary, columns.get("orders")!, hot);
        const children = new Map<ArchivedTable, Record<string, unknown>[]>();
        for (const table of ORDER_CHILD_TABLES) {
            children.set(table, await selectByOrderIds(table, orderIds, columns.get(table)!, hot));
        }

        await this.ensurePartitions(refs, archive);

        const atrx = await archive.transaction();
        try {
            await insertRows("orders", orders, columns.get("orders")!, atrx);
            for (const table of ORDER_CHILD_TABLES) {
                await insertRows(table, children.get(table)!, columns.get(table)!, atrx);
            }
            await atrx.commit();
        } catch (err) {
            await atrx.rollback();
            throw err;
        }

        const htrx = await hot.transaction();
        try {
            // Children before parents; `transactions` deletes charges and the
            // refunds that reference them in one statement, which satisfies
            // its self-FK at statement end.
            for (const table of [...ORDER_CHILD_TABLES].reverse()) {
                const copied = new Set(children.get(table)!.map((row) => Number(row.id)));
                const deleted = await deleteByOrderIds(table, orderIds, htrx);
                const uncopied = deleted.filter((id) => !copied.has(id));
                if (uncopied.length > 0) {
                    throw new StragglerRowError(`${table} ids ${uncopied.join(",")} were not copied`);
                }
            }
            const deletedOrders = await deleteOrders(orderIds, boundary, htrx);
            if (deletedOrders !== orders.length) {
                throw new StragglerRowError(`expected to delete ${orders.length} orders, deleted ${deletedOrders}`);
            }
            await htrx.commit();
        } catch (err) {
            await htrx.rollback();
            throw err;
        }

        const moved: Record<string, number> = {orders: orders.length};
        for (const table of ORDER_CHILD_TABLES) moved[table] = children.get(table)!.length;
        return moved;
    };

    /**
     * Rows that belong to no order, moved by their own timestamp in id order.
     * Each batch is copied, committed in the archive, then deleted by exact id
     * from hot — nothing else can be keyed to a payout or a webhook row, so
     * there is no straggler case here.
     */
    private moveByTime = async (
        table: "transactions" | "payment_webhook_events",
        boundary: Date,
        batchSize: number,
        deadline: number,
        columns: Map<ArchivedTable, TableColumns>,
        hot: Knex,
        archive: Knex,
        region: string,
    ): Promise<number> => {
        const cols = columns.get(table)!;
        let afterId = 0;
        let moved = 0;

        while (Date.now() < deadline) {
            const rows =
                table === "transactions"
                    ? await selectOrderlessTransactions(boundary, afterId, batchSize, cols, hot)
                    : await selectWebhookEvents(boundary, afterId, batchSize, cols, hot);
            if (rows.length === 0) break;

            const ids = rows.map((row) => Number(row.id));
            const atrx = await archive.transaction();
            try {
                await insertRows(table, rows, cols, atrx);
                await atrx.commit();
            } catch (err) {
                await atrx.rollback();
                throw err;
            }

            const htrx = await hot.transaction();
            try {
                await deleteByIds(table, ids, htrx);
                await htrx.commit();
            } catch (err) {
                await htrx.rollback();
                throw err;
            }

            moved += rows.length;
            afterId = ids[ids.length - 1];
            logger.info("archival batch moved", {region, [table]: rows.length});
        }
        return moved;
    };

    /**
     * Month partitions for this batch's orders, created ahead of the insert.
     * A failure here is not fatal — it means the archive's DEFAULT partition
     * already holds rows for that month (Postgres then refuses the new
     * partition), and the insert still succeeds into DEFAULT.
     */
    private ensurePartitions = async (refs: ArchivableOrderRef[], archive: Knex): Promise<void> => {
        const months = new Map<string, Date>();
        for (const ref of refs) {
            const key = `${ref.createdAt.getFullYear()}-${ref.createdAt.getMonth()}`;
            if (!months.has(key)) months.set(key, ref.createdAt);
        }

        for (const month of months.values()) {
            try {
                const created = await ensureArchivePartition(month, archive);
                if (created) logger.info("archive partition created", {partition: created});
            } catch (err) {
                logger.warn("archive partition not created; rows go to orders_default", {
                    month: month.toISOString(),
                    error: (err as Error).message,
                });
            }
        }
    };

    private discoverColumns = async (hot: Knex): Promise<Map<ArchivedTable, TableColumns>> => {
        const tables: ArchivedTable[] = ["orders", ...ORDER_CHILD_TABLES, "payment_webhook_events"];
        const out = new Map<ArchivedTable, TableColumns>();
        for (const table of tables) out.set(table, await readTableColumns(table, hot));
        return out;
    };
}
