import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {toMs} from "../../pkg/utils/time";
import {REGIONS} from "../sharding/regions";
import type {PresenceService} from "../../app/agent/service/presence.service";

/**
 * Collects presence tombstones — spatial entries whose liveness key has
 * expired.
 *
 * **Housekeeping, not correctness.** A tombstone is already invisible to
 * dispatch: the candidate scan drops any member whose meta key is gone, and
 * reaps the ones it trips over on the way. This job exists for the members no
 * search ever visits — an agent who went offline in a part of town nobody
 * orders from would otherwise sit in the geo set forever, because a sorted-set
 * member cannot expire on its own.
 *
 * Skipping a run costs nothing but memory, which is why every failure is a
 * warning rather than a retry, and why there is no lock: two processes reaping
 * the same region both issue `ZREM` for members that are already gone.
 */
export async function runPresenceSweep(): Promise<number> {
    const presence = container.resolve<PresenceService>(TOKENS.PresenceService);

    let reaped = 0;
    for (const region of REGIONS) {
        reaped += await presence.reapStale(region);
    }
    if (reaped > 0) logger.info("presence sweep reaped tombstones", {reaped});
    return reaped;
}

export function startPresenceSweep(): NodeJS.Timeout {
    const timer = setInterval(
        () => void runPresenceSweep(),
        toMs(env.presence.sweepIntervalSec, "s"),
    );
    timer.unref();
    return timer;
}
