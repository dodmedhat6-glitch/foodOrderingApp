/**
 * Live location for a fleet of movable things, with a spatial query over them.
 *
 * App-agnostic on purpose (CLAUDE.md s3): this port knows about ids,
 * coordinates and an opaque "activity" string. It has never heard of agents,
 * orders or regions — the caller supplies a namespace, and `lib/` supplies the
 * Redis client and the TTL from env.
 *
 * The contract has one unusual property worth stating plainly: **presence is
 * allowed to vanish.** There is no durable copy anywhere (see
 * docs/database-design.md s3.8), so every method must behave sanely against an
 * empty store — `findNearest` returns nothing, `touch` re-creates the entry,
 * and no caller may treat absence as an error.
 */

/** One live member, as the spatial query returns it. */
export interface PresenceCandidate {
    memberId: number;
    distanceMeters: number;
    lat: number;
    lng: number;
    /** Whatever the caller stamped with `setActivity`; absent when idle. */
    activity?: string;
}

/** A member's own view of itself — what `read` returns. */
export interface PresenceRecord {
    memberId: number;
    lat: number;
    lng: number;
    lastSeenAt: Date;
    activity?: string;
}

export interface IPresenceStore {
    /**
     * Records (or refreshes) a member's position and resets its liveness TTL.
     *
     * The TTL reset *is* the liveness signal — there is no separate heartbeat
     * and nothing compares timestamps to decide staleness. An existing
     * activity is preserved: moving while busy is the normal case.
     */
    touch(namespace: string, memberId: number, lat: number, lng: number): Promise<void>;

    /** Removes a member entirely. Idempotent — removing an absent member is fine. */
    remove(namespace: string, memberId: number): Promise<void>;

    /** A member's live record, or null if it never registered or has gone stale. */
    read(namespace: string, memberId: number): Promise<PresenceRecord | null>;

    /**
     * Marks what a member is currently busy with, or clears it when `activity`
     * is null. Never resurrects a stale member: if liveness has lapsed there is
     * nothing to annotate, and inventing an entry would put a member who is not
     * there back into the candidate pool.
     */
    setActivity(namespace: string, memberId: number, activity: string | null): Promise<void>;

    /**
     * The nearest live, idle members within `radiusMeters`, nearest first.
     *
     * Three filters, in this order, and all three matter:
     *   - spatial, by the store's own index (not by the caller);
     *   - liveness, by TTL — stale entries are skipped and reaped in passing;
     *   - idleness — a member with an activity is already busy.
     *
     * Returns fewer than `limit` freely, including none at all.
     */
    findNearest(
        namespace: string,
        lat: number,
        lng: number,
        radiusMeters: number,
        limit: number,
    ): Promise<PresenceCandidate[]>;

    /**
     * Drops spatial entries whose liveness has lapsed, returning how many went.
     *
     * Housekeeping, not correctness: `findNearest` already ignores them. It
     * exists because the spatial index cannot expire its own members, so
     * without a sweep it would accumulate every member that ever registered.
     */
    reapStale(namespace: string): Promise<number>;
}
