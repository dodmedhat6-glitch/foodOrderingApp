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
 * `POST /api/internal/branches/:branchId/release-stock` — core's
 * `ReleaseStockResponse`.
 *
 * `missing` holds lines whose branch product row no longer exists, so the
 * units could not be returned anywhere. Core reports them rather than failing
 * the release: the caller is already compensating a failed placement and must
 * not be handed a second failure. Worth logging — it means stock has leaked.
 */
export interface ReleaseStockResult {
    released: Array<{productId: number; quantity: number; remainingStock: number}>;
    missing: Array<{productId: number; quantity: number}>;
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

/**
 * The subset of a branch projection a `core.branch.invalidated` event can
 * carry, and therefore the only fields `CoreProjectionService` will patch in
 * place. A field is present only when core's writing transaction committed
 * that value (its `buildBranchInvalidationPayload`).
 *
 * Deliberately narrower than `BranchLookup`: the lookup joins the restaurant,
 * and a branch event knows nothing about restaurant-level changes.
 */
export type BranchProjectionPatch = Partial<Pick<BranchLookup, "isActive" | "acceptOrders">>;

/**
 * The patchable subset of a product projection, plus the `branchId` that says
 * *which* projection — the keys are per branch+product, so without it the
 * event can only be handled as a delete across every branch.
 *
 * `name` and `imageUrl` are absent on purpose: they live on core's `products`
 * table rather than the branch row the event reports on, so core doesn't send
 * them and a patch must not invent them.
 */
export type ProductProjectionPatch = Partial<
    Pick<ProductLookup, "unitPriceMinor" | "stock" | "isAvailable">
> & {branchId?: number};
