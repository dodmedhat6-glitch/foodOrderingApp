import crypto from "crypto";

/**
 * Kashier's webhook HMAC (https://developers.kashier.io/docs/webhooks, step 4).
 *
 * The signature does **not** cover the raw request body. Kashier signs a
 * canonical projection of it: the `data` object carries a `signatureKeys`
 * array naming which of its own fields were signed, and the payload is those
 * keys sorted alphabetically, each rendered `key=urlencode(value)`, joined
 * with `&`. The digest is HMAC-SHA256 keyed with the **Payment API Key** —
 * the same credential as the order hash, not the secret key — and arrives
 * hex-encoded in `x-kashier-signature`.
 *
 * Signing a projection rather than the bytes has a consequence worth stating
 * plainly: every field *outside* `signatureKeys` is unauthenticated. For
 * Kashier that list is the one that matters — amount, currency, status,
 * method, both order ids and the transaction id — but it means nothing may be
 * trusted from, say, `metaData`, which is why the region we need in order to
 * pick a shard travels inside `merchantOrderId` (a signed field) rather than
 * in metadata.
 */

export interface KashierSignedData {
    signatureKeys?: unknown;
    [key: string]: unknown;
}

/**
 * Builds the exact string Kashier hashed, or null when the payload carries no
 * usable `signatureKeys` array — which is itself a verification failure, not
 * a reason to fall back to signing something else.
 */
export function buildSignaturePayload(data: KashierSignedData): string | null {
    const keys = data.signatureKeys;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    if (!keys.every((k): k is string => typeof k === "string")) return null;

    // Sorted, not in the order received: Kashier sorts before hashing and the
    // array has arrived unsorted in the wild.
    return [...keys]
        .sort()
        .map((key) => `${key}=${encodeURIComponent(stringifyValue(data[key]))}`)
        .join("&");
}

export function computeSignature(data: KashierSignedData, paymentApiKey: string): string | null {
    const payload = buildSignaturePayload(data);
    if (payload === null) return null;

    return crypto.createHmac("sha256", paymentApiKey).update(payload).digest("hex");
}

/**
 * Constant-time comparison of the computed digest against the header.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — that comparison leaks only the length of a hex digest, which is
 * fixed anyway. Hex case is normalised because the docs call for a
 * case-insensitive match.
 */
export function verifySignature(
    data: KashierSignedData,
    signature: string | undefined,
    paymentApiKey: string,
): boolean {
    if (!signature) return false;

    const expected = computeSignature(data, paymentApiKey);
    if (expected === null) return false;

    const received = Buffer.from(signature.trim().toLowerCase(), "utf8");
    const computed = Buffer.from(expected, "utf8");
    if (received.length !== computed.length) return false;

    return crypto.timingSafeEqual(received, computed);
}

/**
 * How a signed value becomes a string.
 *
 * Only scalars ever appear in `signatureKeys`, and `String()` reproduces what
 * Kashier hashed for each of them: `1` stays `1`, `"00"` keeps its leading
 * zero, a boolean is `true`/`false`. An object or array would stringify to
 * something meaningless, so it is rendered empty rather than `[object Object]`
 * — the digest then fails to match, which is the correct outcome for a
 * payload shaped in a way we don't understand.
 */
function stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return "";
    return String(value);
}
