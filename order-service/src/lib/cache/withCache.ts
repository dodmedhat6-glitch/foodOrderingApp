import {Request, Response, NextFunction} from "express";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";

/**
 * Builds the cache key for a request. Supply one when the endpoint's cached
 * pages have to be invalidable as a family: the default key embeds the whole
 * URL, which a service holding only a branch id can't construct or match. A
 * builder puts the invalidation handle at a known position in the key so the
 * service can clear every permutation with one `delByPattern`.
 */
export type CacheKeyBuilder = (req: Request) => string;

export function withCache(ttl = 3600, userScoped = false, keyBuilder?: CacheKeyBuilder) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            let key = keyBuilder ? keyBuilder(req) : `${req.method}:${req.originalUrl}`;
            if (userScoped) key = `${key}:${req.user?.userId}`;
            if (req.region) key = `${req.region}:${key}`;

            const cached = await cacheProvider.get(key);
            if (cached) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    cacheProvider.set(key, JSON.stringify(body), ttl).catch(() => {});
                }
                res.setHeader("X-Cache", "MISS");
                return originalJson(body);
            }) as Response["json"];
            next();
        } catch (err) {
            next(err);
        }
    };
}
