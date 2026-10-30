import Redis, {Cluster} from "ioredis";
import {RedisCacheProvider, type RedisClient} from "../../pkg/cache/redis";
import {env} from "../config/env";

/**
 * Single ioredis connection shared by the cache provider (for get/set/del)
 * and — via duplicate() — the socket.io redis adapter (which needs a
 * separate subscriber connection).
 *
 * REDIS_CLUSTER=true switches to ioredis' Cluster client, for a
 * cluster-mode-enabled server such as an ElastiCache `clustercfg.*`
 * configuration endpoint: it follows MOVED/ASK redirects and routes each key
 * to its shard. REDIS_TLS=true wraps every connection in TLS (ElastiCache
 * with in-transit encryption). Both default off, so local docker stacks are
 * unchanged.
 */
function createRedisClient(): RedisClient {
    const tls = env.redis.tls ? {} : undefined;

    if (env.redis.cluster) {
        return new Cluster([{host: env.redis.host, port: env.redis.port}], {
            // ElastiCache's TLS certificates name the host, not the IP: keep the
            // hostname instead of resolving it, or the handshake can't verify.
            dnsLookup: (address, callback) => callback(null, address),
            lazyConnect: true,
            slotsRefreshTimeout: 2000,
            redisOptions: {
                password: env.redis.password,
                tls,
                maxRetriesPerRequest: 3,
            },
        });
    }

    return new Redis({
        host: env.redis.host,
        port: env.redis.port,
        password: env.redis.password,
        tls,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
    });
}

export const redisClient: RedisClient = createRedisClient();

redisClient.on("error", (err) => console.error("Redis Error:", err.message));
redisClient.connect().catch((err) => console.error("Redis Connect Error:", err.message));

export const cacheProvider = new RedisCacheProvider(redisClient);
