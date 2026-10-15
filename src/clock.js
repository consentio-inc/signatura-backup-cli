/** Wall-clock indirection so timing code can be tested without sleeping. */
export const systemClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
