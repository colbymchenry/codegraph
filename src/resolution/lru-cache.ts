/**
 * Simple LRU cache backed by JavaScript's insertion-ordered Map.
 *
 * Used by ReferenceResolver to bound the per-resolver caches that
 * previously grew without limit and OOM'd on large codebases (20k+
 * files). Each cache is sized independently — see `index.ts` for
 * the chosen limits per cache type.
 *
 * Eviction is plain LRU: on `set`, if the cache is full, the
 * least-recently-used entry is evicted. Touching via `get` moves the
 * entry to the most-recently-used position so hot keys survive eviction
 * passes.
 *
 * Recency is a doubly linked list threaded through the entries, oldest
 * first. Moving an entry is a few pointer writes: doing it by deleting and
 * re-inserting the Map key made a cache hit the single hottest line of
 * resolution, and left the Map's table to rehash as the deleted slots piled up.
 */
interface LRUEntry<K, V> {
  key: K;
  value: V;
  older: LRUEntry<K, V> | null;
  newer: LRUEntry<K, V> | null;
}

export class LRUCache<K, V> {
  private readonly max: number;
  private readonly store = new Map<K, LRUEntry<K, V>>();
  private oldest: LRUEntry<K, V> | null = null;
  private newest: LRUEntry<K, V> | null = null;

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LRUCache max must be a positive finite number, got ${max}`);
    }
    this.max = Math.floor(max);
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    this.touch(entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    const entry = this.store.get(key);
    if (entry !== undefined) {
      entry.value = value;
      this.touch(entry);
      return;
    }
    if (this.store.size >= this.max && this.oldest !== null) {
      this.store.delete(this.oldest.key);
      this.unlink(this.oldest);
    }
    const added: LRUEntry<K, V> = { key, value, older: this.newest, newer: null };
    if (this.newest !== null) this.newest.newer = added;
    else this.oldest = added;
    this.newest = added;
    this.store.set(key, added);
  }

  clear(): void {
    this.store.clear();
    this.oldest = null;
    this.newest = null;
  }

  /** Make an entry the most recently used. */
  private touch(entry: LRUEntry<K, V>): void {
    if (entry === this.newest) return;
    this.unlink(entry);
    entry.older = this.newest;
    entry.newer = null;
    this.newest!.newer = entry;
    this.newest = entry;
  }

  private unlink(entry: LRUEntry<K, V>): void {
    if (entry.older !== null) entry.older.newer = entry.newer;
    else this.oldest = entry.newer;
    if (entry.newer !== null) entry.newer.older = entry.older;
    else this.newest = entry.older;
  }
}
