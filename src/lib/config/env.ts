import path from "path";
import {config} from "dotenv";
import {z} from "zod";

// C:\Users\ABDULLAH\Desktop\quickbite\order-service\.env
config({path: path.resolve(__dirname, "../../../.env")});

const baseSchema = z.object({
    PORT: z.string().default("4000"),
    NODE_ENV: z.string().default("development"),

    ACCESS_SECRET: z.string(),
    REFRESH_SECRET: z.string(),
    ACCESS_EXPIRES_IN: z.string().default("3600"),
    REFRESH_EXPIRES_IN: z.string().default("604800"),

    CORS_ORIGINS: z.string().default("http://localhost:3000"),

    REGIONS: z.string().min(1),

    DB_POOL_MAX: z.string().default("10"),
    DB_MIGRATION_DIRECTORY: z.string().default("src/migrations"),
    DB_MIGRATION_EXTENSION: z.string().default("ts"),

    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.string().default("6379"),
    REDIS_PASSWORD: z.string().default(""),

    RABBITMQ_URL: z.string(),
    RABBITMQ_CORE_EVENTS_EXCHANGE: z.string().default("core.events"),
    RABBITMQ_CORE_EVENTS_QUEUE: z.string().default("order-service.core-events"),
    // Core's routing key *is* its event type, and every one it publishes is
    // `core.<entity>.invalidated` (its lib/events/events.ts). A `product.#`
    // style binding would match nothing at all.
    RABBITMQ_CORE_EVENTS_BINDINGS: z.string().default("core.#"),
    RABBITMQ_CORE_EVENTS_DLX: z.string().default("core.events.dlx"),
    RABBITMQ_CORE_EVENTS_DLQ: z.string().default("order-service.core-events.dlq"),
    RABBITMQ_PREFETCH: z.string().default("32"),

    CORE_SERVICE_BASE_URL: z.string(),
    CORE_INTERNAL_API_KEY: z.string(),

    WS_HEARTBEAT_SEC: z.string().default("30"),

    // ---- orders ----
    // The platform service fee is NOT here: it is a flat constant, the same in
    // every region, and lives in app/order/constants.ts with the reasoning.
    // How long after an order is placed a customer may still cancel it
    // (docs/business-logic/orders.md s9).
    CUSTOMER_CANCELLATION_WINDOW_SEC: z.string().default("60"),
    // TTL for the cached restaurant order list. Short: the dashboard is
    // polled hard, but a stale pending-orders page costs the kitchen time.
    RESTAURANT_ORDERS_CACHE_TTL_SEC: z.string().default("10"),

    // ---- payments (Kashier v3) ----
    // Test and live differ only by the host prefix; the keys are per-mode and
    // a test key never validates against the live host.
    KASHIER_BASE_URL: z.string().default("https://test-api.kashier.io"),
    KASHIER_MERCHANT_ID: z.string(),
    // The *Payment* API Key: the `api-key` header on session creation, and the
    // HMAC key every webhook signature is verified against. There is no
    // separate webhook secret in Kashier — an earlier draft of this plan
    // assumed one (KASHIER_WEBHOOK_SECRET) and it does not exist.
    KASHIER_API_KEY: z.string(),
    // The Secret Key: the actual credential, sent raw in `Authorization`.
    KASHIER_SECRET_KEY: z.string(),
    // Where Kashier returns the customer's browser after checkout. There is no
    // separate failure URL in v3 — `failureRedirect` is a boolean and we send
    // false, keeping a failed attempt on Kashier's page so the customer can
    // retry inside the same session.
    KASHIER_RETURN_URL: z.string(),
    // Per-session server-to-server callback. Optional: left empty, Kashier
    // delivers only to the webhooks configured on the merchant dashboard,
    // which is what a deployed environment uses. Set it to a tunnel URL to
    // receive webhooks on a developer machine.
    KASHIER_SERVER_WEBHOOK_URL: z.string().default(""),
    KASHIER_TIMEOUT_MS: z.string().default("10000"),
    // Attempts the hosted checkout allows before it closes the session.
    KASHIER_MAX_FAILURE_ATTEMPTS: z.string().default("3"),
    KASHIER_DISPLAY_LANGUAGE: z.enum(["en", "ar"]).default("en"),
    // How long a payment session stays open. Also how long an online order
    // holds its reserved stock before the sweep gives it back.
    PAYMENT_SESSION_TIMEOUT_MIN: z.string().default("15"),
    // How often the sweep looks for sessions that have passed expires_at.
    PAYMENT_EXPIRY_SWEEP_INTERVAL_SEC: z.string().default("60"),
});

const parsed = baseSchema.parse(process.env);

function parseRegions(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export interface ShardConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
}

function readShardConfig(region: string, prefix: "DB" | "ARCHIVE_DB"): ShardConfig {
    // eg, DB
    const hostKey = `${prefix}_${region}_HOST`;
    const portKey = `${prefix}_${region}_PORT`;
    const userKey = `${prefix}_${region}_USERNAME`;
    const passKey = `${prefix}_${region}_PASSWORD`;
    const nameKey = `${prefix}_${region}_NAME`;

    const host = process.env[hostKey];
    const port = process.env[portKey];
    const username = process.env[userKey];
    const password = process.env[passKey];
    const name = process.env[nameKey];

    if (!host || !port || !username || name === undefined) {
        throw new Error(
            `Missing ${prefix} env for region "${region}". Expected: ${hostKey}, ${portKey}, ${userKey}, ${passKey}, ${nameKey}`,
        );
    }

    return {
        host,
        port: Number(port),
        username,
        password: password ?? "",
        name,
    };
}

const regions = parseRegions(parsed.REGIONS);
const hotShards: Record<string, ShardConfig> = {};
const archiveShards: Record<string, ShardConfig> = {};
for (const region of regions) {
    hotShards[region] = readShardConfig(region, "DB");
    archiveShards[region] = readShardConfig(region, "ARCHIVE_DB");
}

export const env = {
    port: Number(parsed.PORT),
    isProduction: parsed.NODE_ENV === "production",
    cors: {origins: parsed.CORS_ORIGINS.split(",").map((s) => s.trim())},

    jwt: {
        accessSecret: parsed.ACCESS_SECRET,
        refreshSecret: parsed.REFRESH_SECRET,
        accessExpiresIn: parsed.ACCESS_EXPIRES_IN,
        refreshExpiresIn: parsed.REFRESH_EXPIRES_IN,
    },

    db: {
        poolMax: Number(parsed.DB_POOL_MAX),
        migrationDirectory: path.resolve(
            __dirname,
            "../../../",
            parsed.DB_MIGRATION_DIRECTORY,
        ),
        migrationExtension: parsed.DB_MIGRATION_EXTENSION,
    },

    regions,
    hotShards,
    archiveShards,

    redis: {
        host: parsed.REDIS_HOST,
        port: Number(parsed.REDIS_PORT),
        password: parsed.REDIS_PASSWORD || undefined,
    },

    rabbit: {
        url: parsed.RABBITMQ_URL,
        exchange: parsed.RABBITMQ_CORE_EVENTS_EXCHANGE,
        queue: parsed.RABBITMQ_CORE_EVENTS_QUEUE,
        bindings: parsed.RABBITMQ_CORE_EVENTS_BINDINGS.split(",").map((s) => s.trim()),
        dlx: parsed.RABBITMQ_CORE_EVENTS_DLX,
        dlq: parsed.RABBITMQ_CORE_EVENTS_DLQ,
        prefetch: Number(parsed.RABBITMQ_PREFETCH),
    },

    core: {
        baseUrl: parsed.CORE_SERVICE_BASE_URL,
        internalApiKey: parsed.CORE_INTERNAL_API_KEY,
    },

    ws: {
        heartbeatSec: Number(parsed.WS_HEARTBEAT_SEC),
    },

    orders: {
        customerCancellationWindowSec: Number(parsed.CUSTOMER_CANCELLATION_WINDOW_SEC),
        restaurantListCacheTtlSec: Number(parsed.RESTAURANT_ORDERS_CACHE_TTL_SEC),
    },

    payments: {
        sessionTimeoutMin: Number(parsed.PAYMENT_SESSION_TIMEOUT_MIN),
        expirySweepIntervalSec: Number(parsed.PAYMENT_EXPIRY_SWEEP_INTERVAL_SEC),
        kashier: {
            baseUrl: parsed.KASHIER_BASE_URL,
            merchantId: parsed.KASHIER_MERCHANT_ID,
            apiKey: parsed.KASHIER_API_KEY,
            secretKey: parsed.KASHIER_SECRET_KEY,
            returnUrl: parsed.KASHIER_RETURN_URL,
            serverWebhookUrl: parsed.KASHIER_SERVER_WEBHOOK_URL || undefined,
            timeoutMs: Number(parsed.KASHIER_TIMEOUT_MS),
            maxFailureAttempts: Number(parsed.KASHIER_MAX_FAILURE_ATTEMPTS),
            display: parsed.KASHIER_DISPLAY_LANGUAGE,
        },
    },
};
