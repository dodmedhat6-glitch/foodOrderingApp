import {
    CoreBranchInvalidationPayload,
    CoreInvalidationPayload,
    CoreProductInvalidationPayload,
} from "../types";

/**
 * Payload parsing for the handlers — the equivalent of a controller's
 * `validateBody`, and for the same reason: everything past this point deals in
 * typed values, so no handler or service re-checks what came off the wire.
 */

/**
 * The entity id every invalidation payload carries.
 *
 * A payload without a usable id is a contract break, not a transient fault, so
 * this throws and the consumer dead-letters the message for inspection rather
 * than acking a silent no-op. That is the opposite call from the optional
 * fields below, which are *expected* to be absent.
 */
export function entityId(payload: unknown, eventType: string): number {
    const id = Number((payload as CoreInvalidationPayload | undefined)?.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`${eventType}: payload has no usable entity id`);
    }
    return id;
}

/**
 * The optional trading flags on a branch event.
 *
 * A field is only reported when core sent it as a real boolean. Anything else
 * — absent, null, a string "false" — comes back undefined, which the
 * projection service reads as "unknown" and handles by dropping the projection
 * instead of patching it. Coercing here would be the one genuinely dangerous
 * mistake available: `Boolean("false")` is true, and that would cache a closed
 * branch as open.
 */
export function branchFlags(payload: unknown): {isActive?: boolean; acceptOrders?: boolean} {
    const raw = payload as CoreBranchInvalidationPayload | undefined;
    return {
        isActive: boolOrUndefined(raw?.isActive),
        acceptOrders: boolOrUndefined(raw?.acceptOrders),
    };
}

/** The optional branch-scoped fields on a product event. Same strictness. */
export function productFields(payload: unknown): {
    branchId?: number;
    unitPriceMinor?: number;
    stock?: number;
    isAvailable?: boolean;
} {
    const raw = payload as CoreProductInvalidationPayload | undefined;
    return {
        branchId: positiveIntOrUndefined(raw?.branchId),
        unitPriceMinor: nonNegativeIntOrUndefined(raw?.unitPriceMinor),
        stock: nonNegativeIntOrUndefined(raw?.stock),
        isAvailable: boolOrUndefined(raw?.isAvailable),
    };
}

function boolOrUndefined(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function positiveIntOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeIntOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
