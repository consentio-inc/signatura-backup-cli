/**
 * Runs `body` over `items` with at most `concurrency` in flight.
 *
 * Not fail-fast: if `body` throws, that worker stops, the others drain the
 * queue, then the first error propagates. Phases catch per-item failures, so
 * anything thrown here is fatal (revoked key, full disk).
 */
export async function runPool(items, concurrency, body) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await body(item);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}
