import {AppError} from "../../lib/error/AppError";

/**
 * Canonical finance errors (docs/api-contracts.md s5, s7). Instances, not
 * classes: the wording and status code are part of the contract.
 */

/**
 * The payout is larger than what the platform owes the restaurant in that
 * currency — including the case where it owes nothing because no delivery has
 * settled in that currency yet.
 */
export const InsufficientBalanceError = new AppError("InsufficientBalance", 409);

/**
 * The same `Idempotency-Key` already recorded a *different* payout for this
 * restaurant. The HTTP idempotency layer catches a changed body first; this is
 * the ledger's own answer when that layer has lost its record (24h TTL, Redis
 * flush) and the key comes back with new figures.
 */
export const PayoutIdempotencyConflictError = new AppError("IdempotencyConflict", 409);
