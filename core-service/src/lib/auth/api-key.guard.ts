import { NextFunction, Request, Response } from "express";
import { NotAuthenticated } from "./error";
import { hashApiKey } from "../../pkg/api-key/hash";
import { findActiveApiKeyByHash, touchApiKeyLastUsed } from "../../app/rbac/repository/api-key.repo";
import { SystemRole } from "../../app/user/enums";
import { logger } from "../logger/logger";

const API_KEY_HEADER = "x-api-key";

/**
 * Authenticates a calling *service* (order-service today) via a static
 * shared-secret key instead of a user JWT. On success, populates `req.user`
 * the same way `authenticate` does for humans so downstream `rbac()`
 * middleware needs no special-casing beyond checking `SERVICE_ACCOUNT`
 * (see lib/auth/rbac.ts).
 */
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const key = req.header(API_KEY_HEADER);
        if (!key) {
            throw NotAuthenticated;
        }

        const record = await findActiveApiKeyByHash(hashApiKey(key));
        if (!record) {
            throw NotAuthenticated;
        }

        touchApiKeyLastUsed(record.id).catch((err: unknown) => {
            logger.warn("failed to update api key last_used_at", { apiKeyId: record.id, error: String(err) });
        });

        req.user = {
            user_id: 0,
            email: "",
            role: SystemRole.SERVICE_ACCOUNT,
            serviceName: record.name,
            serviceRole: record.roleName
        };
        next();
    } catch (error) {
        next(error);
    }
}
