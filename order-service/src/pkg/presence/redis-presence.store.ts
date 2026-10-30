import type {RedisClient} from "../cache/redis";
import type {
    IPresenceStore,
    PresenceCandidate,
    PresenceRecord,
} from "./presence.interface";

/**
 * Redis-backed presence, using `GEO` as the spatial index.
 *
 * Two keys per namespace:
 *
 *   presence:{<ns>}:geo          GEO (a ZSET of geohashes) — every known member
 *   presence:{<ns>}:meta:<id>    HASH, TTL = livenessTtlSec — the liveness bit
 *
 * The `{<ns>}` is a cluster hash tag: only the part inside the braces is
 * hashed, so every key of one namespace lands in the same slot. That is what
 * keeps the pipelines below legal on a cluster-mode server, which rejects a
 * pipeline whose keys span slots on different shards.
 *
 * The split exists because of one Redis fact: **a sorted-set member cannot
 * carry its own TTL.** Only whole keys expire. So liveness rides on the per
 * member hash — which can expire — and the geo entry is left behind as a
 * tombstone that `findNearest` filters out and `reapStale` collects. That is
 * the entire reason there are two keys rather than one, and it is also what
 * lets the freshness rule be a TTL rather than a timestamp comparison in
 * application code.
 *
 * Nothing here is app-aware: `namespace` is an opaque string (the caller uses
 * the region), `activity` is an opaque string (the caller uses an order id).
 */
export class RedisPresenceStore implements IPresenceStore {
    constructor(
        private readonly client: RedisClient,
        /** How long after its last `touch` a member stops counting as live. */
        private readonly livenessTtlSec: number,
    ) {}

    /**
     * GEOADD then HSET, pipelined — one round trip, not two.
     *
     * `activity` is deliberately not written here. HSET of the two coordinate
     * fields leaves any existing activity in place, which is what an agent
     * moving mid-delivery needs; and because EXPIRE is reapplied every time,
     * a busy member's liveness is refreshed by the same call that moves them.
     */
    async touch(namespace: string, memberId: number, lat: number, lng: number): Promise<void> {
        const pipeline = this.client.pipeline();
        // GEOADD takes longitude FIRST. Getting this backwards puts the whole
        // fleet in the wrong hemisphere and produces no error at all.
        pipeline.geoadd(this.geoKey(namespace), lng, lat, String(memberId));
        pipeline.hset(this.metaKey(namespace, memberId), {
            lat: String(lat),
            lng: String(lng),
            lastSeenAt: String(Date.now()),
        });
        pipeline.expire(this.metaKey(namespace, memberId), this.livenessTtlSec);
        await pipeline.exec();
    }

    async remove(namespace: string, memberId: number): Promise<void> {
        const pipeline = this.client.pipeline();
        pipeline.zrem(this.geoKey(namespace), String(memberId));
        pipeline.del(this.metaKey(namespace, memberId));
        await pipeline.exec();
    }

    async read(namespace: string, memberId: number): Promise<PresenceRecord | null> {
        const hash = await this.client.hgetall(this.metaKey(namespace, memberId));
        return this.toRecord(memberId, hash);
    }

    /**
     * HSET/HDEL guarded by EXISTS rather than written blind.
     *
     * A blind HSET on a missing key *creates* it — and a hash created this way
     * has no TTL at all, so a member who had gone stale would come back as
     * permanently live. Checking first is a round trip well spent; the
     * alternative silently corrupts the liveness rule.
     */
    async setActivity(namespace: string, memberId: number, activity: string | null): Promise<void> {
        const key = this.metaKey(namespace, memberId);
        if ((await this.client.exists(key)) === 0) return;

        if (activity === null) await this.client.hdel(key, "activity");
        else await this.client.hset(key, "activity", activity);
    }

    /**
     * One GEOSEARCH, then one pipelined read of the candidates' meta keys.
     *
     * Two round trips regardless of how many candidates come back — the thing
     * a per-key cache has to get right (CLAUDE.md s8). Redis does the distance
     * sort and the radius filter; nothing is sorted or measured here.
     *
     * `limit` is applied twice on purpose. Asking Redis for a wider slice
     * (`COUNT limit * OVERSCAN`) and trimming after the liveness/idleness
     * filters means a handful of tombstones or busy members near the branch
     * cannot starve the result down to nothing.
     */
    async findNearest(
        namespace: string,
        lat: number,
        lng: number,
        radiusMeters: number,
        limit: number,
    ): Promise<PresenceCandidate[]> {
        if (limit <= 0) return [];

        const raw = (await this.client.geosearch(
            this.geoKey(namespace),
            "FROMLONLAT",
            lng,
            lat,
            "BYRADIUS",
            radiusMeters,
            "m",
            "ASC",
            "COUNT",
            limit * CANDIDATE_OVERSCAN,
            "WITHDIST",
        )) as unknown as Array<[string, string]>;

        if (raw.length === 0) return [];

        const pipeline = this.client.pipeline();
        for (const [member] of raw) pipeline.hgetall(this.metaKey(namespace, Number(member)));
        const results = (await pipeline.exec()) ?? [];

        const candidates: PresenceCandidate[] = [];
        const tombstones: string[] = [];

        for (let i = 0; i < raw.length; i++) {
            const [member, distance] = raw[i];
            const [err, hash] = (results[i] ?? [null, null]) as [
                Error | null,
                Record<string, string> | null,
            ];

            const record = err ? null : this.toRecord(Number(member), hash);
            // No meta key: liveness lapsed. The geo entry is a leftover.
            if (!record) {
                tombstones.push(member);
                continue;
            }
            // Already carrying something; not available for more.
            if (record.activity) continue;

            candidates.push({
                memberId: record.memberId,
                distanceMeters: Number(distance),
                lat: record.lat,
                lng: record.lng,
            });
        }

        // Opportunistic cleanup: we already know these are dead and we are
        // already here. The sweep catches the ones no search ever visits.
        if (tombstones.length > 0) {
            await this.client.zrem(this.geoKey(namespace), ...tombstones).catch(() => 0);
        }

        return candidates.slice(0, limit);
    }

    /**
     * Walks the geo set in batches and drops members with no live meta key.
     *
     * ZSCAN rather than ZRANGE: the set holds every member that ever
     * registered in a region, and reading it whole to delete a few would be
     * the same mistake `delByPattern` avoids with SCAN.
     */
    async reapStale(namespace: string): Promise<number> {
        const geoKey = this.geoKey(namespace);
        let cursor = "0";
        let reaped = 0;

        do {
            // ZSCAN returns a flat [member, score, member, score, ...] array.
            const [next, flat] = await this.client.zscan(geoKey, cursor, "COUNT", REAP_BATCH);
            cursor = next;

            const members: string[] = [];
            for (let i = 0; i < flat.length; i += 2) members.push(flat[i]);
            if (members.length === 0) continue;

            const pipeline = this.client.pipeline();
            for (const member of members) pipeline.exists(this.metaKey(namespace, Number(member)));
            const results = (await pipeline.exec()) ?? [];

            const dead = members.filter((_, i) => {
                const [err, exists] = (results[i] ?? [null, 1]) as [Error | null, number];
                // On a read error, assume alive. Reaping on a transient failure
                // would evict live members from dispatch for a whole ping cycle.
                return !err && exists === 0;
            });

            if (dead.length > 0) reaped += await this.client.zrem(geoKey, ...dead);
        } while (cursor !== "0");

        return reaped;
    }

    private toRecord(
        memberId: number,
        hash: Record<string, string> | null,
    ): PresenceRecord | null {
        // HGETALL on a missing key returns {} — not null — so emptiness is the
        // "absent" signal, and `lat` being present is what makes it a record.
        if (!hash || hash.lat === undefined) return null;

        return {
            memberId,
            lat: Number(hash.lat),
            lng: Number(hash.lng),
            lastSeenAt: new Date(Number(hash.lastSeenAt)),
            activity: hash.activity || undefined,
        };
    }

    private geoKey(namespace: string): string {
        return `presence:{${namespace}}:geo`;
    }

    private metaKey(namespace: string, memberId: number): string {
        return `presence:{${namespace}}:meta:${memberId}`;
    }
}

/**
 * How many extra candidates to pull from the spatial query before filtering.
 * Tombstones and busy members cluster around a busy branch — exactly where the
 * search happens — so asking for precisely `limit` would routinely return less.
 */
const CANDIDATE_OVERSCAN = 4;

/** ZSCAN page size for the sweep. */
const REAP_BATCH = 200;
