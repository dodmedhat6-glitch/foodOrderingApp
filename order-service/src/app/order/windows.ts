import {toMs} from "../../pkg/utils/time";
import {timestampFromUuidV7} from "../../pkg/utils/uuid";
import {CreatedAtWindow} from "./repository/order.repo";

/**
 * `created_at` windows for reads against the month-partitioned `orders`
 * table. Every read that can bound itself does, so Postgres prunes to the
 * partitions that can hold the row instead of probing all of them.
 */

// Slack on either side of the UUIDv7 timestamp when deriving the partition
// window for a public-id lookup. The id is minted a few milliseconds before
// created_at is stamped, and a generous margin costs at most one extra
// partition probe while making a month-boundary straddle impossible.
const PUBLIC_ID_WINDOW_MS = toMs(1, "m");

/**
 * A `created_at` window covering the last N days, for reads that have no
 * natural bound of their own (an agent's task list, the dispatch sweep).
 *
 * Without one, both queries fan out across every month partition that exists,
 * and they are the two reads that run most often — the sweep every 15 seconds
 * per region, the task list on every agent's poll.
 */
export function recentWindow(days: number): CreatedAtWindow {
    const to = new Date(Date.now() + toMs(1, "d"));
    return {from: new Date(Date.now() - toMs(days, "d")), to};
}

/**
 * Partition window for a public-id lookup, recovered from the UUIDv7
 * timestamp. Returns undefined for a non-v7 id, which means "scan every
 * partition" — correct, just slower, and the only way an id minted before this
 * service moved to v7 stays readable.
 */
export function publicIdWindow(publicId: string): CreatedAtWindow | undefined {
    const minted = timestampFromUuidV7(publicId);
    if (!minted) return undefined;

    return {
        from: new Date(minted.getTime() - PUBLIC_ID_WINDOW_MS),
        to: new Date(minted.getTime() + PUBLIC_ID_WINDOW_MS),
    };
}

/** Local-time year bounds, matching how `created_at` is stored. */
export function yearWindow(year: number): CreatedAtWindow {
    return {from: new Date(year, 0, 1), to: new Date(year + 1, 0, 1)};
}
