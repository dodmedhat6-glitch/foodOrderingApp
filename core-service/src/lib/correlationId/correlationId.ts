import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    req.correlationId = uuidv4();
    res.setHeader('X-Correlation-ID', req.correlationId);
    next();
}