export interface RetryOptions {
  /** Total number of attempts, including the first one. Must be >= 1. */
  attempts: number;
  /** Delay before the second attempt; doubles each time, capped at maxDelayMs. */
  initialDelayMs: number;
  maxDelayMs: number;
  /** Return false to fail fast instead of retrying. Defaults to always retrying. */
  isRetryable?: (err: unknown) => boolean;
  /** Observability hook - called before each backoff wait. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable so tests do not spend real wall-clock time in backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source, in [0, 1). Defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on failure with exponential backoff and full jitter.
 *
 * Full jitter (a random point in [0, delay]) rather than a fixed delay, so that
 * several callers failing against the same downstream at the same moment do not
 * all wake up together and re-stampede it.
 *
 * Pure `pkg/` utility: no logger, no env, no DI - surface observability through
 * `onRetry` and keep time and randomness injectable for tests.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts,
    initialDelayMs,
    maxDelayMs,
    isRetryable = () => true,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  if (attempts < 1) {
    throw new RangeError(`retry: attempts must be >= 1, received ${attempts}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === attempts;
      if (isLastAttempt || !isRetryable(err)) {
        throw err;
      }

      const ceiling = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(random() * ceiling);

      onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
