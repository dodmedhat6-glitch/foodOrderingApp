import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {toMs} from "../../pkg/utils/time";
import {REGIONS} from "../sharding/regions";
import type {PaymentService} from "../../app/payment/service/payment.service";

/**
 * Closes payment sessions the customer can no longer pay on, and cancels the
 * orders behind them.
 *
 * This is not tidying up. An online order reserves its stock in core at
 * placement — before the order row exists — so an abandoned checkout holds
 * units out of circulation indefinitely. `PAYMENT_SESSION_TIMEOUT_MIN` is
 * the bound on that, and this job is what enforces it; without it a branch
 * quietly stops being able to sell whatever someone half-bought an hour ago.
 *
 * Runs on an interval rather than at a scheduled time because the thing it
 * reclaims is minutes old by definition. Everything it does is a
 * compare-and-set, so two processes sweeping the same region concurrently
 * produce one cancellation each at most, and a capture that lands mid-sweep
 * wins outright.
 *
 * The real work is `PaymentService.expireStaleSessions` — this file is the
 * scheduler, exactly as `partition-maintenance.ts` is for partitions.
 * Resolved from the container per tick rather than at module load, so
 * importing this file never forces the payment module's graph to exist
 * (scripts and workers import it without one).
 */
export async function runPaymentExpirySweep(): Promise<number> {
    const payments = container.resolve<PaymentService>(TOKENS.PaymentService);

    let cancelled = 0;
    for (const region of REGIONS) {
        try {
            cancelled += await payments.expireStaleSessions(region);
        } catch (err) {
            // One unreachable shard must not stop the others — the stock it
            // is holding is not the only stock being held.
            logger.error("payment expiry sweep failed", {region, error: (err as Error).message});
        }
    }
    return cancelled;
}

export function startPaymentExpirySweep(): NodeJS.Timeout {
    const intervalMs = toMs(env.payments.expirySweepIntervalSec, "s");

    void runPaymentExpirySweep();
    const timer = setInterval(() => void runPaymentExpirySweep(), intervalMs);
    timer.unref();
    return timer;
}
