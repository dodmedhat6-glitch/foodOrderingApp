/**
 * The instant before which a row belongs to the archive cluster: the start of
 * the current year (CLAUDE.md s7/Archival — only the current year is served
 * from the hot database).
 *
 * Local time, not UTC, because `created_at` is a `TIMESTAMP` without time zone
 * written from a JS `Date` — node-postgres renders it in the process's local
 * zone — and `app/order/windows.ts#yearWindow` bounds reads the same way. A UTC
 * boundary would disagree with both by the zone offset, every New Year.
 *
 * A placement rule, not a routing guarantee: right after New Year, and until
 * the archival worker catches up, prior-year rows are still in the hot shard,
 * so readers of a range below this boundary read *both* clusters.
 */
export function archiveBoundary(now: Date = new Date()): Date {
    return new Date(now.getFullYear(), 0, 1);
}
