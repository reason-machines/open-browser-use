/** Per-key async mutex (I3: one page operation per tab at a time; different tabs run in parallel). */
export class KeyedMutex<K = number> {
  #tails = new Map<K, Promise<void>>();

  async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  isLocked(key: K): boolean {
    return this.#tails.has(key);
  }
}
