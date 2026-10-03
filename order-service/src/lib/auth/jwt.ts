import jwt from "jsonwebtoken";
import {env} from "../config/env";
import {NotAuthenticated} from "./errors";

/**
 * The claim set core-service signs (its src/app/auth/utils.ts). Note
 * `user_id`, not `userId` — the wire format is core's and we decode it as-is,
 * then hand the rest of this service the camelCase shape it expects. Renaming
 * the claim would mean reissuing every live token.
 */
interface CoreAccessTokenClaims {
    user_id: number;
    role: string;
    email: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export interface JWTPayload {
    userId: number;
    role: string;
    email: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

function toPayload(decoded: CoreAccessTokenClaims): JWTPayload {
    return {
        userId: decoded.user_id,
        role: decoded.role,
        email: decoded.email,
        restaurantId: decoded.restaurantId,
        restaurantRole: decoded.restaurantRole,
        branchIds: decoded.branchIds,
    };
}

export function verifyAccessToken(token: string): JWTPayload {
    try {
        const decoded = jwt.verify(token, env.jwt.accessSecret) as jwt.JwtPayload & CoreAccessTokenClaims;
        const payload = toPayload(decoded);
        if (!payload.userId) throw NotAuthenticated;
        return payload;
    } catch {
        throw NotAuthenticated;
    }
}

export function verifyRefreshToken(token: string): JWTPayload {
    try {
        const decoded = jwt.verify(token, env.jwt.refreshSecret) as jwt.JwtPayload & CoreAccessTokenClaims;
        const payload = toPayload(decoded);
        if (!payload.userId) throw NotAuthenticated;
        return payload;
    } catch {
        throw NotAuthenticated;
    }
}
