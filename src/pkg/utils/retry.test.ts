import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry';

/** Deterministic, instant backoff so these tests cost no wall-clock time. */
const instant = {
  attempts: 3,
  initialDelayMs: 50,
  maxDelayMs: 500,
  sleep: async () => {},
  random: () => 1,
};

describe('retry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(retry(fn, instant)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until it succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

    await expect(retry(fn, instant)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error once attempts are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always'));

    await expect(retry(fn, instant)).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast when the error is not retryable', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));

    await expect(retry(fn, { ...instant, isRetryable: () => false })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially, capped at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await retry(fn, {
      attempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 250,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1, // full jitter at its ceiling, so the cap is observable
    }).catch(() => undefined);

    expect(delays).toEqual([100, 200, 250, 250]);
  });

  it('applies jitter rather than a fixed delay', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await retry(fn, {
      attempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    }).catch(() => undefined);

    expect(delays).toEqual([50]);
  });

  it('reports each retry through onRetry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

    await retry(fn, { ...instant, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 50);
  });

  it('rejects a nonsensical attempt count', async () => {
    await expect(retry(async () => 'ok', { ...instant, attempts: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
