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
    // "true" for ElastiCache with in-transit encryption / cluster mode enabled.
    REDIS_TLS: z.string().default("false"),
    REDIS_CLUSTER: z.string().default("false"),

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

    // ---- outbound events (transactional outbox -> RabbitMQ) ----
    // Our own exchange, declared by the worker. Not `core.events`: an
    // exchange belongs to its publisher, and sharing one would let a
    // consumer's `#` binding pick up another service's events by accident.
    RABBITMQ_ORDER_EVENTS_EXCHANGE: z.string().default("order.events"),
    // How often the worker drains every shard's events_outbox. This is the
    // floor on event latency, so it stays small; an idle tick is one indexed
    // query per shard that returns nothing.
    OUTBOUND_EVENTS_DRAIN_TICK_SEC: z.string().default("2"),
    // Rows claimed per shard per tick. The batch's locks are held until every
    // row in it is published, so bigger is not free.
    OUTBOUND_EVENTS_BATCH_SIZE: z.string().default("100"),

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

    // ---- presence (Redis-only; docs/database-design.md s3.8) ----
    // How long after an agent's last ping they still count as live. This value
    // IS the TTL on `presence:{<region>}:meta:<agentId>` — nothing in code
    // compares a timestamp to decide staleness, so changing the rule is
    // changing this number. 300s = the agreed five-minute cutoff, which at a
    // 30s ping cadence tolerates nine missed pings.
    PRESENCE_STALE_SEC: z.string().default("300"),
    // How often the sweep drops geo entries whose meta key has expired. Pure
    // housekeeping: a tombstone is already invisible to the candidate scan.
    PRESENCE_SWEEP_SEC: z.string().default("60"),

    // ---- dispatch ----
    // Radius of the first offer round, from the branch's coordinates.
    ASSIGNMENT_RADIUS_METERS: z.string().default("5000"),
    // Multiplier applied to the radius on each re-offer, and its ceiling.
    ASSIGNMENT_RADIUS_ESCALATION: z.string().default("2"),
    ASSIGNMENT_RADIUS_MAX_METERS: z.string().default("20000"),
    // How many agents an order is offered to at once. They race; the first
    // claim wins and the rest get `task.taken`.
    ASSIGNMENT_CANDIDATES: z.string().default("5"),
    // How long an offer round stands before the sweep re-offers it wider.
    ASSIGNMENT_OFFER_TTL_SEC: z.string().default("45"),
    // How often the sweep looks for `preparing`/`ready` orders nobody has claimed.
    ASSIGNMENT_SWEEP_SEC: z.string().default("15"),
    // Offer rounds before the order is declared stalled and an admin is told.
    // The order stays `ready` — a stalled order is visible, never cancelled.
    MAX_ASSIGNMENT_ATTEMPTS: z.string().default("3"),

    // ---- agent earnings ----
    // Stamped into agent_earnings at settlement and never recomputed, so a
    // later rate change cannot restate last month's earnings. Deliberately
    // independent of what the customer paid: a long cheap delivery still pays
    // the agent for the distance.
    AGENT_EARNING_BASE_MINOR: z.string().default("1500"),
    AGENT_EARNING_PER_KM_MINOR: z.string().default("300"),

    // ---- archival (docs/status.md Phase 5) ----
    // How often the worker wakes to check whether it is inside the nightly
    // window. Outside the window a tick returns without touching a shard.
    ARCHIVAL_INTERVAL_SEC: z.string().default("3600"),
    // The nightly window, local hours [start, end). Archival moves rows across
    // clusters and holds row locks while it does; it runs when traffic is low.
    ARCHIVAL_WINDOW_START_HOUR: z.string().default("2"),
    ARCHIVAL_WINDOW_END_HOUR: z.string().default("5"),
    // Orders (with their items, sessions, ledger and earnings) per batch.
    ARCHIVAL_BATCH_SIZE: z.string().default("1000"),
    // Hard stop per region per night; the next night resumes where it ended.
    ARCHIVAL_MAX_RUNTIME_MIN: z.string().default("60"),
    // How often lapsed rows are purged from idempotency_keys.
    IDEMPOTENCY_PURGE_INTERVAL_SEC: z.string().default("3600"),
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
        tls: parsed.REDIS_TLS === "true",
        cluster: parsed.REDIS_CLUSTER === "true",
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

    outboundEvents: {
        exchange: parsed.RABBITMQ_ORDER_EVENTS_EXCHANGE,
        drainTickSec: Number(parsed.OUTBOUND_EVENTS_DRAIN_TICK_SEC),
        batchSize: Number(parsed.OUTBOUND_EVENTS_BATCH_SIZE),
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

    presence: {
        staleSec: Number(parsed.PRESENCE_STALE_SEC),
        sweepIntervalSec: Number(parsed.PRESENCE_SWEEP_SEC),
    },

    dispatch: {
        radiusMeters: Number(parsed.ASSIGNMENT_RADIUS_METERS),
        radiusEscalation: Number(parsed.ASSIGNMENT_RADIUS_ESCALATION),
        radiusMaxMeters: Number(parsed.ASSIGNMENT_RADIUS_MAX_METERS),
        candidates: Number(parsed.ASSIGNMENT_CANDIDATES),
        offerTtlSec: Number(parsed.ASSIGNMENT_OFFER_TTL_SEC),
        sweepIntervalSec: Number(parsed.ASSIGNMENT_SWEEP_SEC),
        maxAttempts: Number(parsed.MAX_ASSIGNMENT_ATTEMPTS),
    },

    earnings: {
        baseMinor: Number(parsed.AGENT_EARNING_BASE_MINOR),
        perKmMinor: Number(parsed.AGENT_EARNING_PER_KM_MINOR),
    },

    archival: {
        intervalSec: Number(parsed.ARCHIVAL_INTERVAL_SEC),
        windowStartHour: Number(parsed.ARCHIVAL_WINDOW_START_HOUR),
        windowEndHour: Number(parsed.ARCHIVAL_WINDOW_END_HOUR),
        batchSize: Number(parsed.ARCHIVAL_BATCH_SIZE),
        maxRuntimeMin: Number(parsed.ARCHIVAL_MAX_RUNTIME_MIN),
        idempotencyPurgeIntervalSec: Number(parsed.IDEMPOTENCY_PURGE_INTERVAL_SEC),
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
