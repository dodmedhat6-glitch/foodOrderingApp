import {isUuid} from "../../pkg/utils/uuid";
import {MerchantOrderRef} from "./types";

/**
 * The reference we hand the provider as its `order`, and the only correlation
 * handle its webhooks give back.
 *
 * Three things have to survive the round trip, and this string is the only
 * place they can ride:
 *
 *  - **The region.** A webhook arrives with no `X-Region` header — the
 *    provider has never heard of our sharding — and we cannot look anything
 *    up until we have picked a shard. It cannot travel in `metaData` either:
 *    the HMAC covers only the fields named in `signatureKeys`, and
 *    `merchantOrderId` is in that list while `metaData` is not. Routing a
 *    money event on an unauthenticated field would let anyone who guesses the
 *    format aim it at a shard of their choosing.
 *  - **The order.** As the public id, which is a UUIDv7, so the settle path
 *    can derive a `created_at` window and prune to one partition.
 *  - **The attempt.** Kashier rejects a duplicate order reference per
 *    merchant (`ERR_ORD_02`), so a customer retrying after a failed payment
 *    needs a reference that has never been used.
 *
 * The separator is `_` because a UUID contains `-` and nothing else here
 * does, which keeps parsing a plain split with no ambiguity.
 */

const SEPARATOR = "_";

export function buildMerchantOrderRef(
    region: string,
    orderPublicId: string,
    attempt: number,
): string {
    return [region, orderPublicId, attempt].join(SEPARATOR);
}

/**
 * Reverses `buildMerchantOrderRef`, or returns undefined for anything that
 * isn't one of ours.
 *
 * Validating rather than trusting matters here: this runs on an unauthenticated
 * endpoint's input, before the region is used to choose a database. A
 * reference that doesn't parse is a webhook for a payment we did not create.
 */
export function parseMerchantOrderRef(ref: string): MerchantOrderRef | undefined {
    const parts = ref.split(SEPARATOR);
    if (parts.length !== 3) return undefined;

    const [region, orderPublicId, rawAttempt] = parts;
    if (!region || !isUuid(orderPublicId)) return undefined;

    const attempt = Number(rawAttempt);
    if (!Number.isInteger(attempt) || attempt < 1) return undefined;

    return {region, orderPublicId, attempt};
}
