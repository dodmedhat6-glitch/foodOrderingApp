import {createHash} from "crypto";
import {Knex} from "knex";

/**
 * Durable backing store for the idempotency middleware (`idempotency_keys`).
 *
 * Redis serves the hot path; this is what makes a replay still correct after
 * Redis is flushed, restarted, or evicts the key under pressure — which
 * matters because the endpoints it guards create orders and take payments.
 *
 * Exported as functions taking `conn` so the caller can pass a transaction and
 * record the key in the same unit of work as the write it protects.
 */

export interface IdempotencyRecord {
    requestFingerprint: Buffer;
    responseStatus: number;
    responseBody: unknown;
}

export interface StoreIdempotencyInput {
    keyHash: Buffer;
    region: string;
    userId: number;
    requestFingerprint: Buffer;
    responseStatus: number;
    responseBody: unknown;
    ttlSeconds: number;
}

/**
 * Identity of the request: the client-supplied key is scoped by method and
 * path so the same key reused against a different endpoint is a different
 * record rather than a false replay.
 */
export function hashIdempotencyKey(method: string, path: string, key: string): Buffer {
    return createHash("sha256").update(`${method}:${path}:${key}`).digest();
}

/**
 * Fingerprint of the payload, so "same key, different body" can be told apart
 * from a genuine retry. Object keys are sorted before hashing: two JSON bodies
 * that differ only in key order are the same request, and a client that
 * re-serializes its payload shouldn't get a 409.
 */
export function fingerprintBody(body: unknown): Buffer {
    return createHash("sha256").update(canonicalize(body)).digest();
}

export async function tryGet(keyHash: Buffer, conn: Knex): Promise<IdempotencyRecord | undefined> {
    const row = await conn("idempotency_keys")
        .select("request_fingerprint", "response_status", "response_body")
        .where("key_hash", keyHash)
        .where("expires_at", ">", new Date())
        .first();

    if (!row) return undefined;

    return {
        requestFingerprint: row.request_fingerprint,
        responseStatus: row.response_status,
        responseBody: row.response_body,
    };
}

/**
 * Records the outcome. ON CONFLICT DO NOTHING rather than an upsert: if a
 * concurrent request already stored a response for this key, that response is
 * the authoritative one and overwriting it would hand two callers different
 * answers for the same key.
 */
export async function store(data: StoreIdempotencyInput, conn: Knex): Promise<void> {
    const now = new Date();
    await conn("idempotency_keys")
        .insert({
            key_hash: data.keyHash,
            region: data.region,
            user_id: data.userId,
            request_fingerprint: data.requestFingerprint,
            response_status: data.responseStatus,
            response_body: JSON.stringify(data.responseBody),
            created_at: now,
            expires_at: new Date(now.getTime() + data.ttlSeconds * 1000),
        })
        .onConflict("key_hash")
        .ignore();
}

/** Cleanup sweep for lapsed keys; returns the number of rows removed. */
export async function deleteExpired(conn: Knex): Promise<number> {
    return conn("idempotency_keys").where("expires_at", "<=", new Date()).del();
}

function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);

    return `{${entries.join(",")}}`;
}
