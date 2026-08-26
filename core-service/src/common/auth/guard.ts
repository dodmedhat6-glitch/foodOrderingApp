import { NextFunction, Response, Request } from "express";
import { NotAuthenticated } from "./error";
import { verifyAccessToken } from "../../app/auth/utils";
import { days, hours } from "../times"

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const token = req.cookies.access_token;
    if (!token) {
        throw NotAuthenticated
    }
    req.user = verifyAccessToken(token);
    next();
}


export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const secure = process.env.NODE_ENV === 'production';

    res.cookie("access_token", accessToken, {
        httpOnly: true,
        secure,
        maxAge: hours(1)
    });

    res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure,
        maxAge: days(7),
        path: '/api/auth/refresh'
    });
}




