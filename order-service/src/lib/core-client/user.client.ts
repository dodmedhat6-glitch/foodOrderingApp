import {coreClient} from "./core-client";
import {cacheProvider} from "../cache/init";
import {CORE_USER_TTL_SEC, userKey} from "./cache-keys";
import {CoreCallContext, UserLookup} from "./types";

/**
 * Display identity for a user core owns — today, the delivery agent the
 * customer is watching bring their food.
 *
 * Cached, unlike the customer address next door, and the difference is read
 * rate (CLAUDE.md s8). An address is read once per placement, where a stale
 * one means delivering to the wrong place. A name is read on **every poll of
 * a live order's detail**, by a customer refreshing a tracking screen, and a
 * name that is 60 seconds out of date is not a failure anyone can observe.
 *
 * Invalidated explicitly by `core.user.invalidated` as well as by the TTL, so
 * a rename does not linger (lib/core-events/handlers/identity.handler.ts).
 */
export async function getUser(userId: number, ctx: CoreCallContext = {}): Promise<UserLookup> {
    const cached = await cacheProvider.get(userKey(userId)).catch(() => null);
    if (cached) {
        try {
            return JSON.parse(cached) as UserLookup;
        } catch {
            // A projection that no longer parses is a miss, not a failure.
        }
    }

    const user = await coreClient.call<UserLookup>({
        method: "GET",
        path: `/api/internal/users/${userId}`,
        correlationId: ctx.correlationId,
    });

    await cacheProvider
        .set(userKey(user.id), JSON.stringify(user), CORE_USER_TTL_SEC)
        .catch(() => {});

    return user;
}

/**
 * The same, but never throws: resolves to `null` when core is unreachable or
 * does not know the user.
 *
 * Used where identity is decoration rather than substance — the agent block on
 * an order detail. A customer tracking a delivery should not get a 502 because
 * the courier's *name* could not be fetched; the delivery is still happening,
 * and every other field on the response is already in hand.
 */
export async function tryGetUser(
    userId: number,
    ctx: CoreCallContext = {},
): Promise<UserLookup | null> {
    return getUser(userId, ctx).catch(() => null);
}
