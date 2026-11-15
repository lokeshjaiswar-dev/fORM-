/**
 * A least-recently-used cache bounded by weight (bytes, as the caller counts them) as well as by the number of
 * entries. A count alone does not bound memory when entries differ a thousandfold in size: 200 published forms with
 * a few megabytes of pictures each were over a gigabyte. An entry heavier than the whole budget is not kept, and
 * adding one evicts the least recently used until the rest fits.
 */
export class WeightedCache<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private total = 0;

  constructor(maxEntries: number, maxWeight: number) {
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-inserted, so the order of the map is the order of use.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, weight: number): void {
    this.delete(key);
    if (weight > this.maxWeight) return;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size < this.maxEntries && this.total + weight <= this.maxWeight) break;
      this.delete(oldest);
    }
    this.entries.set(key, { value, weight });
    this.total += weight;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The weight of everything held. */
  get weight(): number {
    return this.total;
  }
}
