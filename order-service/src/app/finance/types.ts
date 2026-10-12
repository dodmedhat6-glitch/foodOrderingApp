import {LedgerRange} from "../payment/types";

/**
 * Module-level helper shapes for restaurant finance (CLAUDE.md s5.10).
 */

/** `[from, to)` over a restaurant's ledger. The ledger's own range type. */
export type FinanceRange = LedgerRange;

/** Everything a payout call needs that isn't in its body or path. */
export interface PayoutCallContext {
    region: string;
    idempotencyKey: string;
    correlationId?: string;
}
