export interface ICacheProvider {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
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
