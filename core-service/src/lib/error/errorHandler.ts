import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger.js";
import type {AppError} from "./AppError.js";
import {sendError} from "../http/response.js";

// Keys whose values must never reach the logs: passwords, OTPs, tokens, keys.
const SENSITIVE_KEY = /pass(word)?|otp|token|secret|api[-_]?key|authorization/i;

/** A copy of the request body with sensitive values replaced, at any depth. */
function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, v]) =>
            [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(v)],
        ),
    );
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction) {
    const operational = err.isOperational;

    logger.error(err.message, {
        statusCode: err.statusCode,
        stack: err.stack,
        operational: operational,
        body: redact(req.body),
        correlationId: req.correlationId
    })

    if(operational){
        return sendError(res, err.message, err.statusCode, err.details)
    }
    return sendError(res, "Something went wrong", 500)
}
