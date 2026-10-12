import {Knex} from "knex";
import {ArchivableOrderRef, ArchivedTable, TableColumns} from "../types";

/**
 * Raw row movement between a hot shard and its archive twin.
 *
 * This is the one repository in the service that reads tables owned by other
 * modules (`orders`, `order_items`, `payment_sessions`, `transactions`,
 * `agent_earnings`, `payment_webhook_events`). It does so as a *copier*, not
 * as a reader of their meaning: it never builds an entity, never interprets a
 * status beyond "is this order finished", and writes back exactly the bytes it
 * read. Going through each module's service instead would mean six services
 * growing "give me your rows raw" methods for a single caller.
 *
 * Column lists come from `information_schema` at the start of a run rather
 * than being written out here (CLAUDE.md s9.3 forbids `SELECT *`, not
 * explicit discovery): archive and hot run the same migrations, and a column
 * added by a future migration must be carried across without someone
 * remembering to edit this file.
 */

/**
 * An order is archivable once nothing can happen to it any more. A prior-year
 * order still in flight on New Year's night (placed 23:50, delivered 00:20)
 * waits for the next night rather than being moved out from under its agent.
 */
const TERMINAL_ORDER_STATUSES = ["delivered", "cancelled", "rejected"];

/** The tables whose rows travel with an order, keyed by `order_id`. */
export const ORDER_CHILD_TABLES: readonly ArchivedTable[] = [
    "order_items",
    "payment_sessions",
    "transactions",
    "agent_earnings",
];

/**
 * Column names and which of them need JSON serialising on insert.
 *
 * node-postgres serialises a JS array as a Postgres array literal, so a JSONB
 * value that happens to be an array would be written as `{...}` and rejected —
 * JSON columns are stringified explicitly instead. Generated columns are
 * skipped: Postgres computes them on the archive side too.
 */
export async function readTableColumns(table: ArchivedTable, conn: Knex): Promise<TableColumns> {
    const rows: Array<{column_name: string; data_type: string}> = await conn("information_schema.columns")
        .select("column_name", "data_type")
        .where("table_schema", "public")
        .where("table_name", table)
        .where("is_generated", "NEVER")
        .orderBy("ordinal_position", "asc");

    return {
        names: rows.map((r) => r.column_name),
        json: new Set(rows.filter((r) => r.data_type === "json" || r.data_type === "jsonb").map((r) => r.column_name)),
    };
}

/**
 * The next batch of finished orders created before `boundary`, oldest first.
 *
 * `created_at < boundary` prunes the scan to prior-year partitions — which
 * are exactly the partitions this worker is emptying, so there is nothing to
 * index beyond the partition key.
 */
export async function findArchivableOrders(
    boundary: Date,
    limit: number,
    conn: Knex,
): Promise<ArchivableOrderRef[]> {
    const rows = await conn("orders")
        .select("id", "created_at")
        .where("created_at", "<", boundary)
        .whereIn("status", TERMINAL_ORDER_STATUSES)
        .orderBy("created_at", "asc")
        .limit(limit);

    return rows.map((r: any) => ({id: Number(r.id), createdAt: r.created_at}));
}

/** The order headers themselves, addressed by `(id, created_at)` to prune partitions. */
export async function selectOrders(
    refs: ArchivableOrderRef[],
    columns: TableColumns,
    conn: Knex,
): Promise<Record<string, unknown>[]> {
    if (refs.length === 0) return [];
    return conn("orders")
        .select(columns.names)
        .whereIn(["id", "created_at"], refs.map((r) => [r.id, r.createdAt]));
}

/** Every row of an order-child table belonging to these orders. `id` order keeps self-FKs valid. */
export async function selectByOrderIds(
    table: ArchivedTable,
    orderIds: number[],
    columns: TableColumns,
    conn: Knex,
): Promise<Record<string, unknown>[]> {
    if (orderIds.length === 0) return [];
    return conn(table).select(columns.names).whereIn("order_id", orderIds).orderBy("id", "asc");
}

/**
 * Ledger rows with no order — payouts — created before `boundary`.
 * Backed by the primary key (`id > afterId`) plus the `created_at` filter.
 */
export async function selectOrderlessTransactions(
    boundary: Date,
    afterId: number,
    limit: number,
    columns: TableColumns,
    conn: Knex,
): Promise<Record<string, unknown>[]> {
    return conn("transactions")
        .select(columns.names)
        .whereNull("order_id")
        .where("created_at", "<", boundary)
        .where("id", ">", afterId)
        .orderBy("id", "asc")
        .limit(limit);
}

/** Webhook audit rows received before `boundary`. They name no order, so they go by time. */
export async function selectWebhookEvents(
    boundary: Date,
    afterId: number,
    limit: number,
    columns: TableColumns,
    conn: Knex,
): Promise<Record<string, unknown>[]> {
    return conn("payment_webhook_events")
        .select(columns.names)
        .where("received_at", "<", boundary)
        .where("id", ">", afterId)
        .orderBy("id", "asc")
        .limit(limit);
}

/**
 * Copies rows into the archive, yielding on any key that is already there.
 *
 * `ON CONFLICT DO NOTHING` with no target is what makes a re-run after a crash
 * safe: the archive commits before the hot delete, so a crash in between
 * leaves rows in both places, and the next run re-inserts them as no-ops
 * (docs/implementation-plan.md Phase 5). Ids are copied verbatim — they were
 * minted by the hot shard's sequence, which the archive never advances.
 */
export async function insertRows(
    table: ArchivedTable,
    rows: Record<string, unknown>[],
    columns: TableColumns,
    conn: Knex,
): Promise<void> {
    if (rows.length === 0) return;

    const prepared = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const name of columns.names) {
            const value = row[name];
            out[name] = columns.json.has(name) && value !== null && value !== undefined ? JSON.stringify(value) : value;
        }
        return out;
    });

    // Postgres caps a statement at 65535 bind parameters.
    const chunk = Math.max(1, Math.floor(60000 / columns.names.length));
    for (let i = 0; i < prepared.length; i += chunk) {
        await conn(table).insert(prepared.slice(i, i + chunk)).onConflict().ignore();
    }
}

/**
 * Deletes an order's children from the hot shard and returns the ids it
 * removed, so the caller can prove it deleted nothing it had not copied — a
 * refund written against an archived order between the copy and the delete
 * would otherwise vanish with it.
 */
export async function deleteByOrderIds(table: ArchivedTable, orderIds: number[], conn: Knex): Promise<number[]> {
    if (orderIds.length === 0) return [];
    const rows = await conn(table).whereIn("order_id", orderIds).del().returning("id");
    return rows.map((r: any) => Number(r.id));
}

export async function deleteOrders(refs: ArchivableOrderRef[], conn: Knex): Promise<number> {
    if (refs.length === 0) return 0;
    return conn("orders")
        .whereIn(["id", "created_at"], refs.map((r) => [r.id, r.createdAt]))
        .del();
}

export async function deleteByIds(table: ArchivedTable, ids: number[], conn: Knex): Promise<number> {
    if (ids.length === 0) return 0;
    return conn(table).whereIn("id", ids).del();
}

/**
 * Makes sure the archive has the month partition of `orders` that `month`
 * falls in, so archived rows land in a real partition (and later reads prune
 * to it) instead of piling up in `orders_default`. Returns the partition name
 * when it had to be created.
 *
 * DDL, so it runs outside any transaction, and the bounds are inlined for the
 * same reason as in `app/order/jobs.ts`: Postgres takes no bind parameters in
 * DDL. They are computed here from a Date, never from input. The bounds render
 * as the same `YYYY-MM-01` strings the hot shard's partitions use.
 */
export async function ensureArchivePartition(month: Date, conn: Knex): Promise<string | undefined> {
    const from = new Date(month.getFullYear(), month.getMonth(), 1);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    const name = `orders_${from.getFullYear()}${String(from.getMonth() + 1).padStart(2, "0")}`;

    const exists = await conn.select(conn.raw("1")).from("pg_class").where("relname", name).first();
    if (exists) return undefined;

    await conn.raw(
        `CREATE TABLE IF NOT EXISTS ?? PARTITION OF orders
         FOR VALUES FROM ('${isoDate(from)}') TO ('${isoDate(to)}');`,
        [name],
    );
    return name;
}

function isoDate(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
}
