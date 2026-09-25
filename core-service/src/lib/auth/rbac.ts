import {Request, Response, NextFunction} from "express";

import {SystemRole} from "../../app/user/enums";
import {NotAuthenticated} from "./error";
import {PermissionsCashService} from "../../app/rbac/service/permissions-cash.service";
import {container} from "../di/containers";
import {tokens} from "../di/tokens";
import {sendError} from "../http/response";

const permissionCashService = container.resolve<PermissionsCashService>(tokens.PermissionCashService);


export interface RBACOptions {
    resource: string;
    action: string;
    allowSystemAdmin?: boolean; // by default will be true
}
// check for permissions
// system admin bypass this
// restaurant users must have permissions for their role

// router.post('/products', authenticate, rbac({resource:"product",action:"create"}), productController.create)

export function rbac(options: RBACOptions) {
    return async(req: Request, res: Response, next: NextFunction) => {
        // req.user is there , if not we will bail
        try {
            if (!req.user) {
                throw NotAuthenticated
            }
            const {resource, action, allowSystemAdmin = true} = options;

            // if he is a system admin -> bypass
            if (!allowSystemAdmin && req.user.role == SystemRole.SYSTEM_ADMIN) {
                return next();
            }
            // if restaurant user
            // 1. fetch permissions
            // 2. check if the permissions has the action for this resource
            if (req.user.role == SystemRole.RESTAURANT_USER) {
                const permissions = await permissionCashService.getPermissions(req.user.restaurantRole!);
                if (!permissionCashService.hasPermissions(permissions, resource, action)) {
                    return sendError(res, "Permission denied", 403)
                }
                // pass
                return next();
            }
            // if not restaurant ser -> throw err
            return sendError(res, "Permission denied", 403)
        }
        catch (error) {
            next(error);
        }
    }
}

export function requireRestaurantMember(paramName: string= 'restaurantId') {
    return async(req: Request, res: Response, next: NextFunction) => {
        const restaurantId = parseInt(req.params[paramName] as string); // req.params.restaurantId
        if (!restaurantId) {
            return sendError(res, "something went wrong", 500);
        }

        if (req.user?.role == SystemRole.SYSTEM_ADMIN) return next();
        if (Number(req.user?.restaurantId) !== Number(restaurantId)) {
            return sendError(res, "Permission denied", 403);
        }
        next();
    }
}

export function requireBranchAccess(paramName: string = 'branchId') {
    return async(req: Request, res: Response, next: NextFunction) => {
        const branchId = Number(req.params[paramName]);
        if (!Number.isFinite(branchId) || branchId <= 0) {
            return sendError(res, "Invalid branch id", 400);
        }

        if (!req.user) {
            return sendError(res, "Not authenticated", 401);
        }

        if (req.user.role === SystemRole.SYSTEM_ADMIN) {
            return next();
        }

        if (req.user.role !== SystemRole.RESTAURANT_USER) {
            return sendError(res, "Permission denied", 403);
        }

        const allowedBranchIds = Array.isArray(req.user.branchIds) ? req.user.branchIds : [];
        const hasBranchAccess = allowedBranchIds.some((allowedBranchId) => Number(allowedBranchId) === branchId);

        if (!hasBranchAccess) {
            return sendError(res, "Permission denied", 403);
        }

        return next();
    }
}
