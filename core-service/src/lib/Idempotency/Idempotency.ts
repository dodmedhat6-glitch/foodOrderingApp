import {days} from "../../pkg/utils/times";
import {Request, Response,NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {tokens} from "../di/tokens";
import {container} from "tsyringe";

const TTL = days(1);

export interface IdempotencyOptions {
    strict?: boolean;
}

export function idempotency(options: IdempotencyOptions = {}) {
    const {strict = false} = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        if (!["POST", "PATCH", "PUT"].includes(req.method)) {
            return next();
        }

        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        if (!idempotencyKey) {
            if (strict) {
                return res.status(400).json({
                    error: "Missing Idempotency-Key header",
                });
            }
            return next();
        }

        try {
            const cacheProvider: ICacheProvider = container.resolve(tokens.CacheProvider);
            const key = `idempotency:${req.method}:${req.originalUrl}:${idempotencyKey}`;

            const cached = await cacheProvider.get(key);
            if (cached) {
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = function (body) {
                // Store the response in cache
                cacheProvider.set(key, JSON.stringify(body), TTL);
                return originalJson(body);
            };
            return next();
        } catch {
            if (strict) {
                return res.status(503).json({
                    error: "Idempotency service unavailable",
                });
            }
            return next();
        }
    };
}