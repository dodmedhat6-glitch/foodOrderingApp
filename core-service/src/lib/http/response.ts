import { Response } from 'express';
import {PaginationMeta} from "./pagination/cursor.pagination";

export interface ApiResponse<T= unknown> {
    success: boolean;
    data?: T;
    meta?: object;
}




export function sendSuccess<T>(res: Response , data?: T, statusCode = 200, meta?: object): void {
    const body : ApiResponse<T> = { success: true, data: data};
    if (meta) {
        body.meta = meta;
    }
    res.status(statusCode).json(body);
}

export function sendError(res: Response, message: string, statusCode: number): void {
    res.status(statusCode).json({
        success: false,
        data: {message}
    });
}

export function sendPaginated<T>(res: Response, data: T[], meta: PaginationMeta, statusCode = 200): void {
    sendSuccess(res, data, statusCode, meta);
}