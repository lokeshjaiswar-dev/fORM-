import { WeightedCache } from '../weighted-cache.ts';

/**
 * Short-lived answers of the lookup proxy, in memory (contract section 3): option lists per (version, block) for 60 s and
 * lookup rows per (version, lookup, normalised search) for 30 s. A check is never cached. What is cached is the projection
 * the respondent was already allowed to see (rows with only the declared cells), never the upstream body, and never a
 * credential; the key holds the search term only as part of an in-memory map key.
 */
export const OPTIONS_TTL_MS = 60_000;
export const LOOKUP_TTL_MS = 30_000;
const MAX_ENTRIES = 500;
const MAX_BYTES = 16 * 1024 * 1024;

export class TtlCache<V> {
  private readonly inner = new WeightedCache<{ value: V; expires: number }>(MAX_ENTRIES, MAX_BYTES);

  get(key: string, now: number): V | undefined {
    const hit = this.inner.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.inner.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now: number, ttlMs: number): void {
    // Characters of JSON are about bytes; twice that for the JS objects.
    this.inner.set(key, { value, expires: now + ttlMs }, 2 * JSON.stringify(value).length + key.length);
  }
}
