/**
 * Module-level helper shapes for the archival worker (CLAUDE.md s5.10).
 */

/** Every table the worker moves. */
export type ArchivedTable =
    | "orders"
    | "order_items"
    | "payment_sessions"
    | "transactions"
    | "agent_earnings"
    | "payment_webhook_events";

/** A table's copyable columns, discovered from information_schema. */
export interface TableColumns {
    names: string[];
    /** Columns of type json/jsonb, which must be stringified before insert. */
    json: Set<string>;
}

/** The address of one order row: its partition key is half its primary key. */
export interface ArchivableOrderRef {
    id: number;
    createdAt: Date;
}

/** What one region's run moved, for the log line and the CLI. */
export interface ArchivalRunResult {
    region: string;
    boundary: string;
    orders: number;
    rowsByTable: Record<string, number>;
    batches: number;
    stoppedEarly: boolean;
    ms: number;
}

/** Knobs for one region's run; every field defaults from `env.archival`. */
export interface ArchiveRegionOptions {
    /** Defaults to now; the boundary is the start of this instant's year. */
    now?: Date;
    batchSize?: number;
    maxRuntimeMs?: number;
}
