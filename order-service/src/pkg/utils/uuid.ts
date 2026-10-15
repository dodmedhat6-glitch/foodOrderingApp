import {v7 as uuidv7, validate as uuidValidate, version as uuidVersion} from "uuid";

/**
 * Client-facing ids for this service are UUIDv7 rather than v4.
 *
 * v7 puts a 48-bit big-endian Unix-millisecond timestamp in the leading bytes,
 * which buys two things that matter on a time-partitioned, high-write table:
 *
 *  - A reader holding only a public id can recover when the row was created
 *    and so which `orders` partition to look in — see `timestampFromUuidV7`.
 *    Without it, `GET /api/orders/{publicId}` has to probe every partition's
 *    index because Postgres has no global index across partitions.
 *  - Inserts stay monotonic, so the public_id btree appends to its rightmost
 *    leaf instead of dirtying a random page per write.
 *
 * On the wire it is an ordinary UUID string, so nothing downstream changes.
 */

const UUID_V7_VERSION = 7;

export function newPublicId(): string {
    return uuidv7();
}

export function isUuid(candidate: string): boolean {
    return uuidValidate(candidate);
}

/**
 * Recovers the creation instant embedded in a UUIDv7, or null for any other
 * UUID version. Callers must treat null as "version unknown, can't prune" and
 * fall back to searching every partition — a v4 id minted before this service
 * moved to v7 has to stay readable.
 */
export function timestampFromUuidV7(id: string): Date | null {
    if (!uuidValidate(id) || uuidVersion(id) !== UUID_V7_VERSION) return null;

    // First 12 hex digits (48 bits) are the Unix ms timestamp, big-endian.
    const millis = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    if (!Number.isFinite(millis)) return null;

    return new Date(millis);
}
