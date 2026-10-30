import Redis, {Cluster} from "ioredis";
import type {ICacheProvider} from "./cache.interface";

/**
 * Standalone or cluster-mode connection. Both expose the same command API for
 * everything used here; the one place they differ (SCAN) is handled in
 * `delByPattern`.
 */
export type RedisClient = Redis | Cluster;

export class RedisCacheProvider implements ICacheProvider {
    /**
     * Exposed so integrations that need the raw ioredis connection (e.g. the
     * socket.io redis adapter) can reuse it instead of opening another one.
     * The adapter still needs its own subscriber via `client.duplicate()` —
     * once ioredis is in subscribe mode it can't serve get/set.
     */
    constructor(public readonly client: RedisClient) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    /**
     * One GET per key, issued together, rather than MGET: on a cluster-mode
     * server MGET fails with CROSSSLOT unless every key hashes to the same
     * slot. Concurrent GETs are still written to the socket back to back, so
     * it stays a single round trip per node. The result is aligned with the
     * requested keys, which is the contract callers index against.
     */
    async getMany(keys: string[]): Promise<(string | null)[]> {
        if (keys.length === 0) return [];
        return Promise.all(keys.map((key) => this.client.get(key)));
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    /**
     * Writes many keys concurrently. Same motivation as `getMany`:
     * repopulating a basket's worth of product projections should cost one
     * network hop, not one per line. Not a pipeline: in cluster mode ioredis
     * rejects a pipeline whose keys span slots on different shards.
     */
    async setMany(entries: Array<{key: string; value: string}>, ttlSeconds?: number): Promise<void> {
        if (entries.length === 0) return;

        await Promise.all(
            entries.map(({key, value}) =>
                ttlSeconds ? this.client.set(key, value, "EX", ttlSeconds) : this.client.set(key, value),
            ),
        );
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    /**
     * SCAN + UNLINK rather than KEYS + DEL: KEYS walks the entire keyspace in
     * one blocking call, and DEL on a large batch blocks too. SCAN is
     * incremental and UNLINK frees memory on a background thread, so
     * invalidation can't stall the request path that shares this connection.
     */
    async delByPattern(pattern: string): Promise<number> {
        // SCAN only walks the keyspace of the node it is sent to, so in cluster
        // mode every primary is scanned in turn.
        const nodes: Redis[] = this.client instanceof Cluster ? this.client.nodes("master") : [this.client];
        let removed = 0;

        for (const node of nodes) {
            let cursor = "0";
            do {
                const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", 200);
                cursor = next;
                // One UNLINK per key: a multi-key UNLINK fails with CROSSSLOT on
                // a cluster-mode server unless every key shares a slot.
                if (keys.length > 0) {
                    const counts = await Promise.all(keys.map((key) => this.client.unlink(key)));
                    removed += counts.reduce((sum, n) => sum + n, 0);
                }
            } while (cursor !== "0");
        }

        return removed;
    }

    /**
     * INCR, then EXPIRE only when the result is 1 — i.e. when this call is the
     * one that created the key. Pipelined into a single round trip rather than
     * a Lua script: the two commands are independent (the EXPIRE is decided
     * from a value we already hold), so there is nothing here that needs
     * atomicity beyond INCR's own.
     */
    async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
        const value = await this.client.incr(key);
        if (value === 1) await this.client.expire(key, ttlSeconds);
        return value;
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return res === "OK";
    }
}
