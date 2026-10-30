import Redis, {Cluster} from 'ioredis';
import {ICacheProvider} from "./cache.interface";

export interface RedisConfig{
    host: string;
    port: number;
    password?: string;
    /** Wrap the connection in TLS (ElastiCache with in-transit encryption). */
    tls?: boolean;
    /**
     * Talk to a cluster-mode-enabled server (e.g. an ElastiCache
     * `clustercfg.*` configuration endpoint) through ioredis' Cluster client,
     * which follows MOVED/ASK redirects and routes each key to its shard.
     */
    cluster?: boolean;
}

/** Either client exposes the same command API for everything used here. */
export type RedisClient = Redis | Cluster;

export function createRedisClient(config: RedisConfig): RedisClient {
    const tls = config.tls ? {} : undefined;

    if (config.cluster) {
        return new Cluster([{host: config.host, port: config.port}], {
            // ElastiCache hands out node addresses whose TLS certificates are
            // issued for the hostname, not the IP. Keeping the name (instead of
            // resolving it) is what lets the TLS handshake verify.
            dnsLookup: (address, callback) => callback(null, address),
            lazyConnect: true,
            slotsRefreshTimeout: 2000,
            redisOptions: {
                password: config.password,
                tls,
                maxRetriesPerRequest: 3,
            },
        });
    }

    return new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        tls,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
    });
}


export class RedisCacheProvider implements ICacheProvider {

    private readonly client: RedisClient;

    constructor(config: RedisConfig) {
        this.client = createRedisClient(config);
        this.client.on('error', (err) => {
            console.error('Redis error:', err);
        });

        this.client.connect().catch((err) => {
            console.error('Redis connection error:', err);
        });
    }


    async set(key: string, value: string, ttlSeconds?: number): Promise<any> {
        if (ttlSeconds) {
            await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }



    async del(key: string): Promise<any> {
        await this.client.del(key);
    }

    async get(key: string): Promise<any> {
        return this.client.get(key);
    }
}
