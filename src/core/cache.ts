interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-process TTL cache. Deliberately not Redis: a repeat lookup of the same
 * handle is the single biggest latency win and this covers it for one instance.
 * Swap for Redis when you run more than one worker — the interface is the same.
 */
class TtlCache {
  private store = new Map<string, Entry>();
  private readonly maxEntries = 20_000;

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh insertion order so eviction is roughly LRU.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get size(): number {
    return this.store.size;
  }
}

export const cache = new TtlCache();
