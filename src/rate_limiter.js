import { systemClock } from './clock.js';

/**
 * Enforces a global minimum spacing between outbound requests.
 *
 * 600ms = 100 req/min. The server ceiling is 160/min, keyed by *user*, so the
 * customer's other integrations share the bucket; the headroom is deliberate
 * (spec 3.6).
 */
export class RateLimiter {
  #minInterval;
  #clock;
  /** The earliest instant (ms) at which the next request may be sent. */
  #nextSlot = null;
  /**
   * Set by penalize(). Callers already sleeping on a slot re-check it on
   * waking, so a 429 stops the whole pipeline, not just unscheduled requests.
   */
  #penaltyUntil = null;

  constructor({ minIntervalMs = 600, clock = systemClock } = {}) {
    this.#minInterval = minIntervalMs;
    this.#clock = clock;
  }

  /**
   * Reserves the next send slot and waits until it arrives. Concurrency-safe
   * without locking: the read-modify-write of the slot has no intervening await.
   */
  async acquire() {
    for (;;) {
      const now = this.#clock.now();
      const slot = this.#nextSlot === null || this.#nextSlot < now ? now : this.#nextSlot;
      this.#nextSlot = slot + this.#minInterval;

      const wait = slot - now;
      if (wait <= 0) return;
      await this.#clock.sleep(wait);

      // A 429 that landed while we slept pushes us to a fresh slot.
      const penalty = this.#penaltyUntil;
      if (penalty === null || this.#clock.now() >= penalty) return;
    }
  }

  /** Called on HTTP 429. Defers every slot past `delayMs`, including reserved ones. */
  penalize(delayMs) {
    const candidate = this.#clock.now() + delayMs;
    if (this.#penaltyUntil === null || candidate > this.#penaltyUntil) {
      this.#penaltyUntil = candidate;
    }
    if (this.#nextSlot === null || candidate > this.#nextSlot) {
      this.#nextSlot = candidate;
    }
  }
}
