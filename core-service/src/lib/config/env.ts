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
    // "true" for ElastiCache with in-transit encryption / cluster mode enabled.
    REDIS_TLS: z.string().default("false"),
    REDIS_CLUSTER: z.string().default("false"),
    RABBIT_URL: z.string().default("amqp://localhost:5672"),
    RABBIT_EXCHANGE: z.string().default("core.events"),
    RABBIT_BATCH_SIZE: z.string().default("50"),
    MAILJET_API_KEY: z.string(),
    MAILJET_SECRET_KEY: z.string(),
    MAILJET_FROM_EMAIL: z.string(),
    MAILJET_FROM_NAME: z.string(),
    ORDER_SERVICE_API_KEY: z.string(),
    MEDIA_MAX_UPLOAD_BYTES: z.string().default("5242880"),
})

/**
 * The S3 credentials live in their own schema, parsed on first use rather than
 * at import time. Everything above is needed by any process that boots the
 * app; these four are needed only by the media module, and folding them into
 * the schema above would mean every unit test that transitively imports this
 * file had to supply AWS credentials to get as far as its first assertion.
 */
const s3Schema = z.object({
    AWS_REGION: z.string().default("eu-north-1"),
    S3_BUCKET: z.string(),
    // Optional on purpose. Set them only on a developer machine. On AWS
    // (EC2 instance role, ECS task role) leave them unset and the SDK's
    // default credential chain fetches short-lived, auto-rotated credentials
    // from the metadata service - no long-lived key exists that could leak.
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    S3_SIGNED_URL_EXPIRES_IN: z.string().default("900"),
})

const parsed = schema.parse(process.env)

/**
 * jsonwebtoken reads a *string* with no unit as milliseconds ("3600" = 3.6s),
 * but a *number* as seconds. A bare number in the env means seconds, so hand it
 * over as a number; values with a unit ("1h", "7d") pass through untouched.
 */
function toExpiry(value: string): string | number {
    return /^\d+$/.test(value.trim()) ? Number(value) : value;
}

/**
 * S3 takes a bucket *name*; the console hands out an ARN
 * (arn:aws:s3:::dodsquickbites3). Accept either so the value can be pasted
 * from either place.
 */
function toBucketName(value: string): string {
    return value.startsWith("arn:aws:s3:::") ? value.slice("arn:aws:s3:::".length) : value;
}

export interface S3Env {
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    signedUrlExpiresIn: number;
}

let s3Cache: S3Env | undefined

function loadS3(): S3Env {
    if (s3Cache === undefined) {
        const s3 = s3Schema.parse(process.env)
        s3Cache = {
            region: s3.AWS_REGION,
            bucket: toBucketName(s3.S3_BUCKET),
            accessKeyId: s3.AWS_ACCESS_KEY_ID,
            secretAccessKey: s3.AWS_SECRET_ACCESS_KEY,
            signedUrlExpiresIn: Number(s3.S3_SIGNED_URL_EXPIRES_IN)
        }
    }
    return s3Cache
}

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
        accessExpires: toExpiry(parsed.ACCESS_EXPIRATION),
        refreshExpires: toExpiry(parsed.REFRESH_EXPIRATION)
    },
    isProduction: process.env.NODE_ENV === "production",

    cors: {
        origin: parsed.CORS_ORIGIN.split(","),
    },

    redis: {
        host: parsed.REDIS_HOST,
        port: Number(parsed.REDIS_PORT),
        password: parsed.REDIS_PASSWORD,
        tls: parsed.REDIS_TLS === "true",
        cluster: parsed.REDIS_CLUSTER === "true"
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
    },

    // Object storage for the media module (app/media) - see pkg/storage/s3.ts.
    // A getter, not a value: reading it is what validates the credentials, so
    // a process that never touches media never needs them. Throws a ZodError
    // naming the missing keys, same as the rest of the schema would.
    get s3(): S3Env {
        return loadS3()
    },

    media: {
        maxUploadBytes: Number(parsed.MEDIA_MAX_UPLOAD_BYTES)
    }
}