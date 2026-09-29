/**
 * A small in-process TTL cache.
 *
 * Deliberately not Redis: one process, a few dozen entries, and nothing that needs to
 * survive a restart (PROJECT_SPEC.md §15 — no Redis without a proven need). Losing the
 * cache on restart costs one extra request.
 *
 * There is nothing cleverer available. Tennis TV sends no `ETag`, `Last-Modified` or
 * `Cache-Control` (docs/TENNISTV_DATA_SOURCE.md §10), so conditional requests are
 * impossible and time-to-live is the only lever.
 */

export interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: Date;
  readonly expiresAt: number;
}

export class TtlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? ((): number => Date.now());
  }

  get(key: string): CacheEntry<T> | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }

    // Refresh insertion order so the oldest *unused* entry is evicted first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;

    if (this.#entries.size >= this.#maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }

    this.#entries.set(key, {
      value,
      storedAt: new Date(this.#now()),
      expiresAt: this.#now() + ttlMs,
    });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
