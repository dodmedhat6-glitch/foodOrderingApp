import { IPubSubProvider } from '../../pkg/pubsub/pubsub.interface';
import { ICacheProvider } from '../../pkg/cache/cache.interface';
import { logger } from '../logger/logger';

/**
 * Subscribes to core-service's `core:invalidate:{entityType}` channels
 * (01-system-design.md §5.1) and deletes the matching `cache:core:*` key -
 * delete, not refresh, so the next reader repopulates it correctly on demand.
 */
export async function startInvalidationSubscriber(
  pubSub: IPubSubProvider,
  cache: ICacheProvider,
): Promise<void> {
  await pubSub.psubscribe('core:invalidate:*', (channel, message) => {
    const entityType = channel.split(':')[2];
    if (!entityType) {
      logger.warn('invalidation event on malformed channel', { channel });
      return;
    }

    let id: string | number | undefined;
    try {
      const parsed = JSON.parse(message) as { id?: string | number };
      id = parsed.id;
    } catch {
      logger.warn('invalidation event with non-JSON payload', { channel, message });
      return;
    }

    if (id === undefined) {
      logger.warn('invalidation event missing id', { channel, message });
      return;
    }

    const key = `cache:core:${entityType}:${id}`;
    cache.del(key).catch((err: unknown) => {
      logger.error('failed to delete invalidated cache key', { key, error: String(err) });
    });
  });

  logger.info('cache invalidation subscriber started', { pattern: 'core:invalidate:*' });
}
