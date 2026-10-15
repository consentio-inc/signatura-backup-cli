import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateLimiter } from '../src/rate_limiter.js';
import { RetryPolicy } from '../src/retry_policy.js';
import { ApiError, NotFoundError, ThrottledError, UnauthorizedError } from '../src/errors.js';
import { FakeClock } from './fake_clock.js';

test('spaces concurrent requests by the minimum interval', async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ minIntervalMs: 600, clock });
  const start = clock.now();
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  // The fake clock advances as each sleep is issued, so the third caller
  // sees the second one's wait already elapsed.
  assert.deepEqual(clock.sleeps, [600, 600]);
  assert.equal(clock.now(), start + 1200);
});

test('a penalty defers slots already reserved', async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ minIntervalMs: 600, clock });
  await limiter.acquire();
  limiter.penalize(5000);
  await limiter.acquire();
  assert.equal(clock.sleeps.at(-1), 5000);
});

test('retry backs off on transient errors and reports waiting', async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ clock });
  const waits = [];
  const retry = new RetryPolicy({ limiter, clock, onTransientWait: (w) => waits.push(w) });
  let calls = 0;
  const result = await retry.run(async () => {
    calls++;
    if (calls < 3) throw new ApiError(500, 'boom');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(clock.sleeps, [1000, 2000]);
  // Reported on every attempt; the runner dedupes.
  assert.deepEqual(waits, [true, true, false]);
});

test('retry gives up after maxAttempts and passes fatal errors straight through', async () => {
  const clock = new FakeClock();
  const retry = new RetryPolicy({ limiter: new RateLimiter({ clock }), clock, maxAttempts: 2 });
  await assert.rejects(retry.run(async () => { throw new ApiError(500, 'x'); }), ApiError);
  assert.equal(clock.sleeps.length, 1);
  let calls = 0;
  await assert.rejects(retry.run(async () => { calls++; throw new UnauthorizedError('no'); }), UnauthorizedError);
  await assert.rejects(retry.run(async () => { calls++; throw new NotFoundError('no'); }), NotFoundError);
  assert.equal(calls, 2);
});

test('throttling penalises the limiter without consuming attempts', async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ clock });
  const retry = new RetryPolicy({ limiter, clock, maxAttempts: 2, maxConsecutiveThrottles: 3 });
  let calls = 0;
  const result = await retry.run(async () => {
    calls++;
    if (calls <= 3) throw new ThrottledError(1000);
    return 'ok';
  });
  assert.equal(result, 'ok');
  await assert.rejects(retry.run(async () => { throw new ThrottledError(1000); }), /Throttled 4 times/);
});
