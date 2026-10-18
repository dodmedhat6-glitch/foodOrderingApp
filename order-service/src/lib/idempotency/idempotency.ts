import {Request, Response, NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {toSeconds} from "../../pkg/utils/time";
import {AppError} from "../error/AppError";
import {db} from "../knex/knex";
import {logger} from "../logger/logger";
import {fingerprintBody, hashIdempotencyKey, store, tryGet} from "./idempotency-store";

const TTL = toSeconds(1, "d");

// How long a request may hold the in-flight marker. Longer than any request
// this guards is allowed to take, short enough that a crashed process doesn't
// lock the key out for the full 24h window.
const IN_FLIGHT_TTL_SEC = 60;

const IdempotencyConflict = new AppError("IdempotencyConflict", 409);
const IdempotencyKeyMissing = new AppError("Missing Idempotency-Key header", 400);
const IdempotencyInProgress = new AppError("IdempotencyRequestInProgress", 409);

interface IdempotencyOptions {
    strict?: boolean;
}

interface CachedOutcome {
    fingerprint: string;
    status: number;
    body: unknown;
}

/**
 * Replays the response of a previously-seen `Idempotency-Key` instead of
 * running the handler twice.
 *
 * Two layers, on purpose. Redis answers the common case in one round trip;
 * the `idempotency_keys` table is consulted on a Redis miss so that losing
 * Redis degrades to slower, not to double-charging. The request body is
 * fingerprinted both times, which is what separates a legitimate retry (same
 * key, same body -> replay) from a client bug (same key, different body ->
 * 409, per docs/api-contracts.md s1.1).
 *
 * Only 2xx responses are recorded. Pinning a failure would make a transient
 * error permanent for that key, when the caller's correct move is to retry it.
 */
export function idempotency(options: IdempotencyOptions = {}) {
    const {strict = false} = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        if (!["POST", "PATCH", "PUT"].includes(req.method)) return next();

        const header = req.headers["idempotency-key"];
        const idempotencyKey = Array.isArray(header) ? header[0] : header;

        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
            if (strict) return next(IdempotencyKeyMissing);
            return next();
        }

        const cache = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
        const redisKey = `idempotency:${req.method}:${req.originalUrl}:${idempotencyKey}`;
        const keyHash = hashIdempotencyKey(req.method, req.originalUrl, idempotencyKey);
        const fingerprint = fingerprintBody(req.body);
        const fingerprintHex = fingerprint.toString("hex");

        try {
            const cached = await cache.get(redisKey);
            if (cached) {
                const outcome = JSON.parse(cached) as CachedOutcome;
                if (outcome.fingerprint !== fingerprintHex) return next(IdempotencyConflict);
                return res.status(outcome.status).json(outcome.body);
            }
        } catch (err) {
            // A Redis outage must not take the endpoint down: fall through to
            // the durable store, which is the reason it exists.
            logger.warn("idempotency: redis lookup failed, falling back to db", {
                error: (err as Error).message,
            });
        }

        const conn = req.region && req.region !== "all" ? db(req.region) : undefined;
        if (conn) {
            try {
                const record = await tryGet(keyHash, conn);
                if (record) {
                    if (!record.requestFingerprint.equals(fingerprint)) return next(IdempotencyConflict);
                    return res.status(record.responseStatus).json(record.responseBody);
                }
            } catch (err) {
                if (strict) return next(err);
                logger.warn("idempotency: db lookup failed", {error: (err as Error).message});
            }
        }

        // Claim the key before running the handler so two concurrent requests
        // with the same key can't both place the order. The loser is told to
        // retry rather than served a half-built response.
        try {
            const claimed = await cache.trySet(`${redisKey}:in-flight`, "1", IN_FLIGHT_TTL_SEC);
            if (!claimed) return next(IdempotencyInProgress);
        } catch {
            // Can't claim without Redis; the fingerprint checks above plus the
            // table's primary key still prevent a duplicate from being
            // *recorded*, so proceed rather than fail the request.
        }

        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                void persist({
                    cache,
                    redisKey,
                    keyHash,
                    fingerprint,
                    fingerprintHex,
                    status: res.statusCode,
                    body,
                    region: req.region,
                    userId: req.user?.userId,
                });
            } else {
                void cache.del(`${redisKey}:in-flight`).catch(() => {});
            }
            return originalJson(body);
        }) as Response["json"];

        next();
    };
}

interface PersistInput {
    cache: ICacheProvider;
    redisKey: string;
    keyHash: Buffer;
    fingerprint: Buffer;
    fingerprintHex: string;
    status: number;
    body: unknown;
    region?: string;
    userId?: number;
}

/**
 * Best-effort on both layers, and deliberately not awaited by the response
 * path: the write already committed, so failing to record the key would only
 * mean a retry re-runs the handler — far better than failing a request whose
 * work succeeded.
 */
async function persist(input: PersistInput): Promise<void> {
    const outcome: CachedOutcome = {
        fingerprint: input.fingerprintHex,
        status: input.status,
        body: input.body,
    };

    await input.cache.set(input.redisKey, JSON.stringify(outcome), TTL).catch((err: unknown) => {
        logger.warn("idempotency: redis store failed", {error: String(err)});
    });

    if (input.region && input.region !== "all" && input.userId) {
        await store(
            {
                keyHash: input.keyHash,
                region: input.region,
                userId: input.userId,
                requestFingerprint: input.fingerprint,
                responseStatus: input.status,
                responseBody: input.body,
                ttlSeconds: TTL,
            },
            db(input.region),
        ).catch((err: unknown) => {
            logger.warn("idempotency: db store failed", {error: String(err)});
        });
    }

    await input.cache.del(`${input.redisKey}:in-flight`).catch(() => {});
}
