import { systemClock } from './clock.js';
import { ApiError, DiskFullError, NotFoundError, ThrottledError, UnauthorizedError } from './errors.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * Retries transient failures; lets fatal and semantically-meaningful ones through.
 *
 * 429 does not consume the attempt budget; it defers the global rate limiter
 * instead. `maxConsecutiveThrottles` guards against endless throttling.
 */
export class RetryPolicy {
  #clock;

  constructor({ limiter, maxAttempts = 5, maxConsecutiveThrottles = 50, clock = systemClock, onTransientWait = null }) {
    this.limiter = limiter;
    this.maxAttempts = maxAttempts;
    this.maxConsecutiveThrottles = maxConsecutiveThrottles;
    this.#clock = clock;
    /** true on a backoff wait, false once the call succeeds or gives up (spec 3.12). */
    this.onTransientWait = onTransientWait;
  }

  async run(action) {
    let attempt = 0;
    let throttles = 0;
    let notifiedWaiting = false;

    // Every exit must clear the waiting indicator, or an aborted run keeps
    // showing "Reconectando..." indefinitely.
    try {
      for (;;) {
        try {
          return await action();
        } catch (error) {
          if (error instanceof UnauthorizedError) throw error;
          if (error instanceof NotFoundError) throw error;
          if (error instanceof DiskFullError) throw error;
          if (error instanceof ThrottledError) {
            throttles++;
            if (throttles > this.maxConsecutiveThrottles) {
              throw new ApiError(429, `Throttled ${throttles} times in a row`);
            }
            this.limiter.penalize(error.retryAfterMs);
            continue;
          }
          attempt++;
          if (attempt >= this.maxAttempts) throw error;
          notifiedWaiting = true;
          this.onTransientWait?.(true);
          await this.#clock.sleep(BACKOFF_MS[attempt - 1]);
        }
      }
    } finally {
      if (notifiedWaiting) this.onTransientWait?.(false);
    }
  }
}
