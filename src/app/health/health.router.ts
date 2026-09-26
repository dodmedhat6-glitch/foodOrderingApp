import { Router } from 'express';
import { testAllPools } from '../../lib/db/regions';
import { sendError, sendSuccess } from '../../lib/http/response';
import { cacheProvider } from '../../lib/cache/init';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    const regions = await testAllPools();
    const allRegionsUp = Object.values(regions).every((r) => r.hot && r.archive);

    let redisUp = true;
    try {
      await cacheProvider.set('health:ping', 'pong', 5);
      redisUp = (await cacheProvider.get('health:ping')) === 'pong';
    } catch {
      redisUp = false;
    }

    if (!allRegionsUp || !redisUp) {
      return sendError(res, 'One or more dependencies are unreachable', 503);
    }

    sendSuccess(res, { status: 'ok', regions, redis: 'ok' });
  } catch (error) {
    sendError(res, error instanceof Error ? error.message : 'Health check failed', 500);
  }
});
