import {Request, Response, NextFunction} from "express";
import {NotAuthenticated, PermissionDenied} from "./errors";
import {getRolePermissions} from "../core-client/rbac.client";
import {SystemRole} from "./roles";

export interface RBACOptions {
    resource: string;
    /**
     * Either a fixed action, or one derived from the request.
     *
     * The derived form exists because one endpoint can need different
     * permissions depending on what it is asked to do: `PATCH .../status` is
     * `orders:accept` when the target is `accepted`, `orders:cancel` when it
     * is `cancelled` and `orders:update` otherwise
     * (docs/business-logic/rbac.md s3). Splitting that into three routes would
     * contradict s4's one-status-endpoint-per-resource rule, and deciding it
     * in the service would mean the permission check happens after the body
     * has already been applied.
     *
     * Returning `undefined` denies: a resolver that cannot name an action has
     * been handed a request it does not recognise, and the safe reading of
     * that is "no permission covers this".
     */
    action: string | ((req: Request) => string | undefined);
    allowSystemAdmin?: boolean; // default true
}

/**
 * Permission check against the projection of core's RBAC catalog
 * (lib/core-client/rbac.client.ts). Same semantics as core's own `rbac()`:
 * system admins bypass, restaurant users are checked against the permissions
 * of their restaurant role, everyone else is denied.
 *
 * Endpoints whose authorization is about *identity* rather than a permission —
 * a customer placing their own order, an agent moving their own delivery — use
 * `requireRole` plus an ownership check in the service, not this middleware.
 */
export function rbac(options: RBACOptions) {
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (!req.user) throw NotAuthenticated;
            const {resource, action, allowSystemAdmin = true} = options;

            if (allowSystemAdmin && req.user.role === SystemRole.SYSTEM_ADMIN) return next();

            if (req.user.role === SystemRole.RESTAURANT_USER) {
                const restaurantRole = req.user.restaurantRole;
                if (!restaurantRole) throw PermissionDenied;

                const resolved = typeof action === "function" ? action(req) : action;
                if (!resolved) throw PermissionDenied;

                const permissions = await getRolePermissions(restaurantRole, {
                    correlationId: req.correlationId,
                });
                if (!permissions.has(`${resource}:${resolved}`)) throw PermissionDenied;
                return next();
            }

            throw PermissionDenied;
        } catch (err) {
            next(err);
        }
    };
}

export function requireRestaurantMember(paramName: string = "restaurantId") {
    return (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user) throw NotAuthenticated;
        if (req.user.role === SystemRole.SYSTEM_ADMIN) return next();

        const restaurantId = positiveIdParam(req, paramName);
        if (restaurantId === undefined) throw PermissionDenied;
        if (Number(req.user.restaurantId) !== restaurantId) throw PermissionDenied;
        next();
    };
}

/**
 * Restricts a restaurant user to the branches they are a member of. An owner
 * is scoped to their whole restaurant, so they pass without a branch list.
 *
 * A branch the endpoint does not name cannot be checked here, and on the
 * nested `/restaurants/:restaurantId/branches/:branchId/...` tree that case no
 * longer arises — the branch is in the path, so a request that reaches this
 * middleware always names exactly one. A *malformed* branch id is denied
 * rather than waved through: letting it fall to the service would mean the
 * narrowing depended on a value this middleware had already declined to read.
 */
export function requireBranchAccess(paramName: string = "branchId") {
    return (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user) throw NotAuthenticated;
        if (req.user.role === SystemRole.SYSTEM_ADMIN) return next();

        const branchId = positiveIdParam(req, paramName);
        if (branchId === undefined) throw PermissionDenied;

        // An owner is scoped to the whole restaurant, which
        // `requireRestaurantMember` has already established — but only after
        // the branch id itself has been shown to be well-formed, so the
        // scoped query below cannot be handed a NaN.
        if (req.user.restaurantRole === "owner") return next();

        const allowed = req.user.branchIds ?? [];
        if (!allowed.some((id) => Number(id) === branchId)) throw PermissionDenied;
        next();
    };
}

/**
 * One positive integer id from the path, falling back to the query string for
 * the endpoints that still carry it there.
 *
 * Express 5 types a repeated param or query key as an array; only the
 * single-value form is an id, so an array reads as absent rather than being
 * silently narrowed to its first element.
 */
function positiveIdParam(req: Request, paramName: string): number | undefined {
    const raw = req.params[paramName] ?? req.query[paramName];
    if (typeof raw !== "string") return undefined;

    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}
