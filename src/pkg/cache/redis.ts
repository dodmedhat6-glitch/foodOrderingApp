import Redis from "ioredis";
import type {ICacheProvider} from "./cache.interface";

export class RedisCacheProvider implements ICacheProvider {
    /**
     * Exposed so integrations that need the raw ioredis connection (e.g. the
     * socket.io redis adapter) can reuse it instead of opening another one.
     * The adapter still needs its own subscriber via `client.duplicate()` —
     * once ioredis is in subscribe mode it can't serve get/set.
     */
    constructor(public readonly client: Redis) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    /**
     * `mget` is variadic and errors on an empty argument list, so the empty
     * case short-circuits. ioredis returns `(string | null)[]` aligned with
     * the requested keys, which is the contract callers index against.
     */
    async getMany(keys: string[]): Promise<(string | null)[]> {
        if (keys.length === 0) return [];
        return this.client.mget(keys);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    /**
     * Writes many keys in one round trip via a pipeline. Same motivation as
     * `getMany`: repopulating a basket's worth of product projections should
     * cost one network hop, not one per line.
     */
    async setMany(entries: Array<{key: string; value: string}>, ttlSeconds?: number): Promise<void> {
        if (entries.length === 0) return;

        const pipeline = this.client.pipeline();
        for (const {key, value} of entries) {
            if (ttlSeconds) pipeline.set(key, value, "EX", ttlSeconds);
            else pipeline.set(key, value);
        }
        await pipeline.exec();
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
        let cursor = "0";
        let removed = 0;

        do {
            const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 200);
            cursor = next;
            if (keys.length > 0) removed += await this.client.unlink(...keys);
        } while (cursor !== "0");

        return removed;
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return res === "OK";
    }
}
