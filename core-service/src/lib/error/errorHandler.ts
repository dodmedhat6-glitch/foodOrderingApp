import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger.js";
import type {AppError} from "./AppError.js";

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
        return res.status(err.statusCode).json({
            error: err.message,
        })
    }
    return res.status(500).json({
        error: 'Something went wrong',
    })
}
