/**
 * Simple LRU cache backed by JavaScript's insertion-ordered Map.
 *
 * Used by ReferenceResolver to bound the per-resolver caches that
 * previously grew without limit and OOM'd on large codebases (20k+
 * files). Each cache is sized independently — see `index.ts` for
 * the chosen limits per cache type.
 *
 * Eviction is plain LRU: on `set`, if the cache is full, the
 * least-recently-used entry (the first one in iteration order) is
 * evicted. Touching via `get` moves the entry to the most-recently-used
 * position so hot keys survive eviction passes.
 */
export class LRUCache<K, V> {
  private readonly max: number;
  private readonly maxWeight: number | null;
  private readonly weightOf: ((value: V, key: K) => number) | null;
  private readonly store = new Map<K, V>();
  private readonly weights = new Map<K, number>();
  private totalWeight = 0;

  constructor(
    max: number,
    opts: { maxWeight: number; weightOf: (value: V, key: K) => number } | null = null
  ) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LRUCache max must be a positive finite number, got ${max}`);
    }
    if (opts && (!Number.isFinite(opts.maxWeight) || opts.maxWeight <= 0)) {
      throw new Error(`LRUCache maxWeight must be a positive finite number, got ${opts.maxWeight}`);
    }
    this.max = Math.floor(max);
    this.maxWeight = opts ? Math.floor(opts.maxWeight) : null;
    this.weightOf = opts?.weightOf ?? null;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      // Distinguish "missing" from "stored undefined" by checking has().
      // We don't store undefined in practice, but be defensive.
      return this.store.has(key) ? value : undefined;
    }
    // Refresh recency by re-inserting.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.totalWeight -= this.weights.get(key) ?? 0;
      this.store.delete(key);
      this.weights.delete(key);
    }

    const weight = this.weightOf ? Math.max(0, Math.ceil(this.weightOf(value, key))) : 0;
    if (this.maxWeight !== null && weight > this.maxWeight) return;

    while (
      this.store.size >= this.max ||
      (this.maxWeight !== null && this.totalWeight + weight > this.maxWeight)
    ) {
      // Evict the oldest entry — first key in iteration order.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.totalWeight -= this.weights.get(oldest) ?? 0;
      this.weights.delete(oldest);
      this.store.delete(oldest);
    }
    this.store.set(key, value);
    if (this.maxWeight !== null) {
      this.weights.set(key, weight);
      this.totalWeight += weight;
    }
  }

  clear(): void {
    this.store.clear();
    this.weights.clear();
    this.totalWeight = 0;
  }
}
