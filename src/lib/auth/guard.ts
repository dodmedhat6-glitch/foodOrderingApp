import {NextFunction, Request, Response} from "express";
import {verifyAccessToken} from "./jwt";
import {NotAuthenticated, PermissionDenied} from "./errors";
import {SystemRole} from "./roles";

export function authenticate(req: Request, _res: Response, next: NextFunction) {
    // Accept the bearer form as well as the cookie: the cookie is what the web
    // client sends, but service-side tooling and the WS handshake carry the
    // same token in a header.
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const token = req.cookies?.access_token ?? bearer;
    if (!token) throw NotAuthenticated;

    req.user = verifyAccessToken(token);
    next();
}

/**
 * Restricts an endpoint to specific system roles. Use this where
 * authorization is about *who* the caller is rather than a permission in
 * core's catalog — `POST /api/orders` is for customers, full stop — and leave
 * `rbac()` for the restaurant-role permission checks.
 */
export function requireRole(...roles: SystemRole[]) {
    return (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user) throw NotAuthenticated;
        if (!roles.includes(req.user.role as SystemRole)) throw PermissionDenied;
        next();
    };
}
