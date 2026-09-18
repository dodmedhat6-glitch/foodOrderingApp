import Redis from 'ioredis';
import {ICacheProvider} from "./cache.interface";

export interface RedisConfig{
    host: string;
    port: number;
    password?: string;
}


export class RedisCacheProvider implements ICacheProvider {

    private readonly client: Redis;

    constructor(config: RedisConfig) {
        this.client = new Redis({
            host: config.host,
            port: config.port,
            password: config.password,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
        });
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

