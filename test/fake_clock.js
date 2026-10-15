/** A clock that advances only when sleeps resolve, so timing tests run instantly. */
export class FakeClock {
  // Starts at real time: the engine pins `created_before` from this clock.
  #now = Date.now();
  sleeps = [];

  now() {
    return this.#now;
  }

  async sleep(ms) {
    this.sleeps.push(ms);
    this.#now += ms;
  }
}
