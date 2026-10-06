export interface ICacheProvider {
    get(key: string): Promise<string | null>;

    /**
     * Reads many keys in one round trip, returning a value (or null) per key,
     * positionally. The point is the round trip, not the keys: N sequential
     * `get`s against a remote Redis cost N network latencies, which is what
     * makes a per-key cache lose to a single upstream call. One MGET makes the
     * granular key the better option instead — see core-client/product.client.ts.
     */
    getMany(keys: string[]): Promise<(string | null)[]>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;

    /** The write-side counterpart of `getMany`: one round trip for N keys. */
    setMany(entries: Array<{key: string; value: string}>, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<number>;

    /**
     * Deletes every key matching a glob pattern, returning how many went.
     * For invalidating a family of cached pages at once (one branch's order
     * list across all its query permutations) where the exact keys aren't
     * known to the caller. Must be implemented with a cursor scan, never a
     * blocking KEYS.
     */
    delByPattern(pattern: string): Promise<number>;

    /**
     * Atomic "set if absent". Returns true if the key was newly set, false if
     * it already existed. Used for dedupe / distributed locks.
     */
    trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
}
