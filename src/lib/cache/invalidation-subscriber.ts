import { IEventConsumer } from '../../pkg/message-broker/message-broker.interface';
import { ICacheProvider } from '../../pkg/cache/cache.interface';
import { logger } from '../logger/logger';

const DEDUPE_TTL_SECONDS = 600;

/**
 * Consumes core-service's cache-invalidation events off the shared
 * `core.events` topic exchange (routing keys `core.<entityType>.invalidated`,
 * 01-system-design.md §5.1) and deletes the matching `cache:core:*` key -
 * delete, not refresh, so the next reader repopulates it correctly on
 * demand.
 *
 * Unlike the old Redis Pub/Sub link, RabbitMQ redelivers a message that
 * wasn't acked (crash, nack), so the same eventId can arrive twice - it's
 * deduped here via the cache before being acted on a second time.
 */
export async function startInvalidationSubscriber(
  consumer: IEventConsumer,
  cache: ICacheProvider,
): Promise<void> {
  await consumer.consume(async (event) => {
    const dedupeKey = `dedupe:event:${event.eventId}`;
    const alreadyHandled = await cache.get(dedupeKey);
    if (alreadyHandled) {
      return;
    }

    const key = `cache:core:${event.entityType}:${event.entityId}`;
    try {
      await cache.del(key);
    } catch (err) {
      logger.error('failed to delete invalidated cache key', { key, error: String(err) });
      throw err;
    }

    await cache.set(dedupeKey, '1', DEDUPE_TTL_SECONDS);
  });

  logger.info('cache invalidation subscriber started');
}
