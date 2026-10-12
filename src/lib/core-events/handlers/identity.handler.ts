import {container} from "../../di/container";
import {CoreEventHandler} from "../types";
import {TOKENS} from "../../di/tokens";
import {CoreProjectionService} from "../../core-client/projection.service";
import {CoreEventType} from "../event-types";
import {entityId} from "./payload";

/**
 * `core.address.invalidated` — acknowledged and ignored.
 *
 * Addresses are not cached. One is read through on every placement and
 * immediately snapshotted onto the order row
 * (core-client/address.client.ts): a stale projection there means delivering
 * to the wrong place, which is the one failure mode worth a round trip every
 * single time.
 *
 * Registered explicitly rather than left to the consumer's "no handler"
 * warning, so that warning keeps meaning what it says — an event nobody wired
 * up — instead of firing on an event we have decided to drop.
 */
export const handleIgnoredEvent: CoreEventHandler = async () => {};

/**
 * `core.user.invalidated` — drops the cached display identity.
 *
 * This used to be ignored alongside addresses, because nothing read users.
 * Phase 3 changed that: the customer's tracking screen shows the delivery
 * agent's name, which is polled hard enough to be worth a 60-second
 * projection (core-client/user.client.ts). A cache with no invalidation is a
 * cache that serves a renamed user until its TTL lapses, so the event now has
 * somewhere to go.
 *
 * Delete rather than patch: core's user payload carries only `{ id }`, so
 * there is nothing to correct the projection *with*. The next read fetches
 * the current name. That is the rule in CLAUDE.md — patch when the payload
 * carries every field, delete when it does not.
 */
export const handleUserInvalidated: CoreEventHandler = async (payload) => {
    const userId = entityId(payload, CoreEventType.USER_INVALIDATED);
    const projections = container.resolve<CoreProjectionService>(TOKENS.CoreProjectionService);
    await projections.forgetUser(userId);
};
