export interface CoreClientRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;                       // e.g. "/api/internal/branches/123"
    body?: unknown;
    correlationId?: string;
    idempotencyKey?: string;
}

/**
 * Per-request context threaded from the controller through the service into
 * every outbound core call, so a single customer action is traceable across
 * both services and so write calls to core carry our idempotency key.
 */
export interface CoreCallContext {
    correlationId?: string;
    idempotencyKey?: string;
}

/** core-service wraps every reply as `{success, data}` (its lib/http/response.ts). */
export interface CoreEnvelope<T> {
    success: boolean;
    data: T;
}

/**
 * `GET /api/internal/branches/:branchId`.
 *
 * Mirrors core's `BranchLookupResponse` in src/app/internal/service/internal.service.ts.
 * These two shapes are a hand-maintained contract: a mismatch surfaces as
 * `undefined` at runtime here, not a type error there. Keep them in lockstep.
 */
export interface BranchLookup {
    id: number;
    restaurantId: number;
    restaurantName: string;
    restaurantStatus: string;
    countryCode: string;
    currency: string;
    name: string;
    addressText: string;
    lat: number;
    lng: number;
    isActive: boolean;
    acceptOrders: boolean;
    deliveryFeeMinor: number;
    commission: number;
}

/** `GET /api/internal/addresses/:addressId` — core's `AddressLookupResponse`. */
export interface AddressLookup {
    id: number;
    customerId: number;
    lat: number;
    lng: number;
    addressText: string;
}

/** `GET /api/internal/products?branchId=&ids=` — core's `ProductLookupResponse`. */
export interface ProductLookup {
    id: number;
    branchId: number;
    name: string;
    imageUrl: string | null;
    unitPriceMinor: number;
    isAvailable: boolean;
    stock: number;
}

/** `POST /api/internal/branches/:branchId/reserve-stock`. */
export interface ReserveStockItem {
    productId: number;
    quantity: number;
}

export interface ReserveStockResult {
    reserved: Array<{productId: number; quantity: number; remainingStock: number}>;
}

/**
 * `GET /api/roles/:role/permissions` — core's `memberService.getRolePermissions`.
 *
 * Not under `/api/internal`: core exposes the role catalog on its public rbac
 * router, so this is the one core call that carries no api-key requirement.
 * Permissions arrive pre-flattened as `"resource:action"` strings, which is
 * also how the middleware compares them.
 */
export interface RolePermissionsLookup {
    role: string;
    permissions: Array<{permission: string}>;
}
