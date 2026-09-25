import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger.js";
import type {AppError} from "./AppError.js";
import {sendError} from "../http/response.js";

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction) {
    const operational = err.isOperational;

    logger.error(err.message, {
        statusCode: err.statusCode,
        stack: err.stack,
        operational: operational,
        body: req.body,
        correlationId: req.correlationId
    })

    if(operational){
        return sendError(res, err.message, err.statusCode)
    }
    return sendError(res, "Something went wrong", 500)
}
