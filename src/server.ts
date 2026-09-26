import 'reflect-metadata';
import http from 'http';
import { createApp } from './app';
import { env } from './lib/config/env';
import { logger } from './lib/logger/logger';
import { container } from './lib/di/containers';
import { tokens } from './lib/di/tokens';
import { closeAllPools } from './lib/db/regions';
import { cacheProvider } from './lib/cache/init';
import { pubSubProvider } from './lib/pubsub/init';
import { startInvalidationSubscriber } from './lib/cache/invalidation-subscriber';
import { initWsGateway } from './lib/ws/init';

const app = createApp();
const server = http.createServer(app);

const wsGateway = initWsGateway(server);
container.registerInstance(tokens.WsGateway, wsGateway);

startInvalidationSubscriber(pubSubProvider, cacheProvider).catch((err: unknown) => {
  logger.error('failed to start cache invalidation subscriber', { error: String(err) });
});

server.listen(env.port, () => {
  logger.info(`order-service listening on port ${env.port}`, { regions: env.regionCodes });
});

async function shutdown() {
  logger.info('shutting down order-service...');
  server.close(async () => {
    logger.info('http server closed');
    await closeAllPools();
    await pubSubProvider.quit();
    await cacheProvider.quit();
    await wsGateway.close();
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
