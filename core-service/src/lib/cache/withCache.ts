import {NextFunction , Response , Request} from "express";
import {container} from "../di/containers";
import {tokens} from "../di/tokens";
import {ICacheProvider} from "../../pkg/cache/cache.interface";

/**
 * @param keyFn builds the cache key for a request. Defaults to method + full URL;
 *              a route passes its own when two different URLs should share an
 *              entry (e.g. nearby searches a few metres apart).
 */
export function withCache(ttl = 3600 , userScoped = false, keyFn?: (req: Request) => string) {
    return async (req: Request , res: Response, next: NextFunction) => {
        try {
            const cacheProvider: ICacheProvider = container.resolve(tokens.CacheProvider)

            let key = keyFn ? keyFn(req) : `${req.method}:${req.originalUrl}`;

            if (userScoped) {
                key = `${key}:${req.user?.user_id}`;
            }
            const cached = await cacheProvider.get(key);
            if (cached) {
                res.setHeader('X-Cache', 'HIT');
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: any) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    void cacheProvider.set(key, JSON.stringify(body), ttl).catch((err) => {
                        console.error('Cache write error:', err);
                    });
                }
                res.setHeader('X-Cache', 'MISS');
                return originalJson(body);

            });
            next();
        }
        catch (err) {
            next(err);
        }
    }


}