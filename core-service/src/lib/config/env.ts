import { config } from 'dotenv';
import path from 'path';
import { z } from 'zod';

config({ path: path.resolve(__dirname, '../../../.env') });

const schema = z.object({
    PORT: z.string().default("3000"),
    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.string().default("5432"),
    DB_USER: z.string().default("postgres"),
    DB_PASSWORD: z.string(),
    DB_NAME: z.string(),
    DB_POOL_MAX: z.string().default("10"),
    DB_MIGRATIONS_DIRECTORY: z.string(),
    DB_MIGRATIONS_EXTENSION: z.string(),
    ACCESS_SECRET: z.string(),
    REFRESH_SECRET: z.string(),
    ACCESS_EXPIRATION: z.string(),
    REFRESH_EXPIRATION: z.string(),
    CORS_ORIGIN: z.string().default("https://localhost:3001"),
    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.string().default("6379"),
    REDIS_PASSWORD: z.string().optional(),
    RABBIT_URL: z.string().default("amqp://localhost:5672"),
    RABBIT_EXCHANGE: z.string().default("core.events"),
    RABBIT_BATCH_SIZE: z.string().default("50"),
    MAILJET_API_KEY: z.string(),
    MAILJET_SECRET_KEY: z.string(),
    MAILJET_FROM_EMAIL: z.string(),
    MAILJET_FROM_NAME: z.string(),
    ORDER_SERVICE_API_KEY: z.string(),
})

const parsed = schema.parse(process.env)

export const env = {
    port: Number(parsed.PORT),
    db: {
        host: parsed.DB_HOST,
        port: Number(parsed.DB_PORT),
        user: parsed.DB_USER,
        password: parsed.DB_PASSWORD,
        name: parsed.DB_NAME,
        poolMax: Number(parsed.DB_POOL_MAX),
        migrationsDirectory: path.resolve(__dirname, '../../../', parsed.DB_MIGRATIONS_DIRECTORY),
        migrationsExtension: parsed.DB_MIGRATIONS_EXTENSION

    },
    jwt: {
        refreshSecret: parsed.REFRESH_SECRET,
        accessSecret: parsed.ACCESS_SECRET,
        accessExpires: parsed.ACCESS_EXPIRATION,
        refreshExpires: parsed.REFRESH_EXPIRATION
    },
    isProduction: process.env.NODE_ENV === "production",

    cors: {
        origin: parsed.CORS_ORIGIN.split(","),
    },

    redis: {
        host: parsed.REDIS_HOST,
        port: Number(parsed.REDIS_PORT),
        password: parsed.REDIS_PASSWORD
    },

    rabbit: {
        url: parsed.RABBIT_URL,
        exchange: parsed.RABBIT_EXCHANGE,
        batchSize: Number(parsed.RABBIT_BATCH_SIZE)
    },

    mailjet: {
        apiKey: parsed.MAILJET_API_KEY,
        secretKey: parsed.MAILJET_SECRET_KEY,
        fromEmail: parsed.MAILJET_FROM_EMAIL,
        fromName: parsed.MAILJET_FROM_NAME
    },

    // service-to-service API keys, keyed by consumer name. The plaintext only
    // ever exists here (to seed/rotate the stored hash) and on the calling
    // service's own side - core-service never persists it, only its hash
    // (see pkg/api-key/hash.ts, app/rbac/repository/api-key.repo.ts).
    serviceApiKeys: {
        orderService: parsed.ORDER_SERVICE_API_KEY
    }
}