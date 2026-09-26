import { describe, expect, it, vi } from 'vitest';
import { startInvalidationSubscriber } from './invalidation-subscriber';
import type { IPubSubProvider, PubSubHandler } from '../../pkg/pubsub/pubsub.interface';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';

function fakePubSub() {
  let handler: PubSubHandler | undefined;
  return {
    provider: {
      publish: vi.fn(),
      psubscribe: vi.fn(async (_pattern: string, h: PubSubHandler) => {
        handler = h;
      }),
      quit: vi.fn(),
    } satisfies IPubSubProvider,
    emit(channel: string, message: string) {
      handler?.(channel, message);
    },
  };
}

function fakeCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn().mockResolvedValue(undefined),
  } satisfies ICacheProvider;
}

describe('startInvalidationSubscriber', () => {
  it('deletes the matching cache:core:<entityType>:<id> key on a valid event', async () => {
    const { provider, emit } = fakePubSub();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);
    emit('core:invalidate:product', JSON.stringify({ id: 42, occurredAt: Date.now() }));
    await Promise.resolve();

    expect(cache.del).toHaveBeenCalledWith('cache:core:product:42');
  });

  it('subscribes on the core:invalidate:* pattern', async () => {
    const { provider } = fakePubSub();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);

    expect(provider.psubscribe).toHaveBeenCalledWith('core:invalidate:*', expect.any(Function));
  });

  it('ignores malformed payloads without throwing', async () => {
    const { provider, emit } = fakePubSub();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);
    emit('core:invalidate:product', 'not json');
    await Promise.resolve();

    expect(cache.del).not.toHaveBeenCalled();
  });
});
