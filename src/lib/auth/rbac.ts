import {Request, Response, NextFunction} from "express";
import {NotAuthenticated, PermissionDenied} from "./errors";
import {getRolePermissions} from "../core-client/rbac.client";
import {SystemRole} from "./roles";

export interface RBACOptions {
    resource: string;
    action: string;
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

                const permissions = await getRolePermissions(restaurantRole, {
                    correlationId: req.correlationId,
                });
                if (!permissions.has(`${resource}:${action}`)) throw PermissionDenied;
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

        const restaurantId = Number(req.params[paramName] ?? req.query[paramName]);
        if (!Number.isFinite(restaurantId) || restaurantId <= 0) throw PermissionDenied;
        if (Number(req.user.restaurantId) !== restaurantId) throw PermissionDenied;
        next();
    };
}

/**
 * Restricts a restaurant user to the branches they are a member of. An owner
 * is scoped to their whole restaurant, so they pass without a branch list.
 * When the endpoint names no branch, this is a no-op and the service does the
 * narrowing.
 */
export function requireBranchAccess(paramName: string = "branchId") {
    return (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user) throw NotAuthenticated;
        if (req.user.role === SystemRole.SYSTEM_ADMIN) return next();
        if (req.user.restaurantRole === "owner") return next();

        const branchId = Number(req.params[paramName] ?? req.query[paramName]);
        if (!Number.isFinite(branchId) || branchId <= 0) return next();

        const allowed = req.user.branchIds ?? [];
        if (!allowed.some((id) => Number(id) === branchId)) throw PermissionDenied;
        next();
    };
}
