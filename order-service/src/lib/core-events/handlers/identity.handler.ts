import {CoreEventHandler} from "../types";

/**
 * `core.address.invalidated` and `core.user.invalidated` — acknowledged and
 * ignored.
 *
 * Neither is cached. An address is read through on every placement and
 * immediately snapshotted onto the order row (core-client/address.client.ts):
 * a stale projection there means delivering to the wrong place, which is the
 * one failure mode worth a round trip every time. Users are not read at all.
 *
 * Registered explicitly rather than left to the consumer's "no handler"
 * warning, so that warning keeps meaning what it says — an event nobody wired
 * up — instead of firing twice a day on events we have decided to drop.
 */
export const handleIgnoredEvent: CoreEventHandler = async () => {};
