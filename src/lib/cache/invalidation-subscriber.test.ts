import { describe, expect, it, vi } from 'vitest';
import { startInvalidationSubscriber } from './invalidation-subscriber';
import type { ConsumedEvent, EventHandler, IEventConsumer } from '../../pkg/message-broker/message-broker.interface';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';

function fakeConsumer() {
  let handler: EventHandler | undefined;
  return {
    provider: {
      connect: vi.fn(),
      consume: vi.fn(async (h: EventHandler) => {
        handler = h;
      }),
      close: vi.fn(),
    } satisfies IEventConsumer,
    emit(event: ConsumedEvent) {
      return handler?.(event);
    },
  };
}

function fakeCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn().mockResolvedValue(undefined),
  } satisfies ICacheProvider;
}

function event(overrides: Partial<ConsumedEvent> = {}): ConsumedEvent {
  return {
    eventId: 'event-1',
    eventType: 'core.product.invalidated',
    entityType: 'product',
    entityId: 42,
    occurredAt: new Date().toISOString(),
    payload: { id: 42, occurredAt: new Date().toISOString() },
    ...overrides,
  };
}

describe('startInvalidationSubscriber', () => {
  it('deletes the matching cache:core:<entityType>:<id> key on a valid event', async () => {
    const { provider, emit } = fakeConsumer();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);
    await emit(event());

    expect(cache.del).toHaveBeenCalledWith('cache:core:product:42');
  });

  it('registers a handler with the consumer', async () => {
    const { provider } = fakeConsumer();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);

    expect(provider.consume).toHaveBeenCalledWith(expect.any(Function));
  });

  it('skips a redelivered event whose eventId was already handled', async () => {
    const { provider, emit } = fakeConsumer();
    const cache = fakeCache();

    await startInvalidationSubscriber(provider, cache);
    await emit(event());
    await emit(event());

    expect(cache.del).toHaveBeenCalledTimes(1);
  });

  it('rethrows (so the message is nacked) when cache.del fails', async () => {
    const { provider, emit } = fakeConsumer();
    const cache = fakeCache();
    cache.del.mockRejectedValueOnce(new Error('redis down'));

    await startInvalidationSubscriber(provider, cache);

    await expect(emit(event())).rejects.toThrow('redis down');
  });
});
