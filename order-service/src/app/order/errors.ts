import {AppError} from "../../lib/error/AppError";

/**
 * Canonical, user-facing order errors. Wording and status codes are part of the
 * contract (docs/api-contracts.md s1), so services throw these instances
 * rather than constructing ad-hoc AppErrors — a message can't drift per call
 * site, and the two parameterized cases below keep their extra fields in one
 * place.
 */

export const OrderNotFoundError = new AppError("OrderNotFound", 404);

export const BranchNotAcceptingOrdersError = new AppError("BranchNotAcceptingOrders", 409);

export const AddressNotOwnedError = new AppError("AddressNotOwned", 403);

export const CancellationWindowExpiredError = new AppError("CancellationWindowExpired", 409);

export const ReasonRequiredError = new AppError("ReasonRequired", 400);

export const DuplicateProductInOrderError = new AppError("DuplicateProductInOrder", 400);

export interface OutOfStockLine {
    productId: number;
    requested: number;
    available: number;
}

/** 409 carrying the offending lines, per docs/api-contracts.md s1.1. */
export function outOfStockError(details: OutOfStockLine[]): AppError {
    return new AppError("OutOfStock", 409, true, {details});
}

/** 409 naming the illegal edge, per docs/api-contracts.md s1.5. */
export function invalidStatusTransitionError(from: string, to: string): AppError {
    return new AppError("InvalidStatusTransition", 409, true, {from, to});
}

/**
 * 409 for a transition that exists but must not be reached through
 * `PATCH /status` — entering or leaving `assigned` moves `delivery_agent_id`
 * and `assigned_at` too, so it belongs to /claim, /unclaim and /assign, which
 * write every column in one UPDATE.
 */
export function dispatchManagedTransitionError(from: string, to: string): AppError {
    return new AppError("DispatchManagedTransition", 409, true, {
        from,
        to,
        use: "POST /api/orders/{publicId}/claim | /unclaim | /assign",
    });
}
