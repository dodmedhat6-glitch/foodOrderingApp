import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {toMs} from "../../pkg/utils/time";
import {REGIONS} from "../sharding/regions";
import type {AssignmentService} from "../../app/delivery/service/assignment.service";

/**
 * Offers `preparing` and `ready` orders to nearby agents, over and over until one is claimed.
 *
 * **This is dispatch's entry point, not a hook on the `ready` transition.**
 * A post-commit hook fires exactly once, at the instant a cook presses a
 * button. If no agent happens to be online in that second, the order sits
 * `ready` forever and nothing ever reconsiders it. The hook can only make the
 * common case fast; the sweep is what makes it correct.
 *
 * That is also why re-offering is cheap enough to do every 15 seconds: an
 * offer is a WebSocket message, not a row. Nothing is written, so there is
 * nothing to clean up when nobody claims.
 *
 * Runs per region and tolerates a dead one: an unreachable shard — or an
 * unreachable Redis, which stops dispatch entirely by design — must not stop
 * the regions that are fine. The orders it could not offer are still `ready`,
 * and the next pass finds them.
 */
export async function runAssignmentSweep(): Promise<number> {
    const assignment = container.resolve<AssignmentService>(TOKENS.AssignmentService);

    let offered = 0;
    for (const region of REGIONS) {
        try {
            const outcomes = await assignment.sweepRegion(region);
            offered += outcomes.filter((outcome) => outcome.candidates > 0).length;
        } catch (err) {
            logger.error("assignment sweep failed", {region, error: (err as Error).message});
        }
    }
    return offered;
}

export function startAssignmentSweep(): NodeJS.Timeout {
    const intervalMs = toMs(env.dispatch.sweepIntervalSec, "s");

    void runAssignmentSweep();
    const timer = setInterval(() => void runAssignmentSweep(), intervalMs);
    timer.unref();
    return timer;
}
