/**
 * Pool ↔ thread-budget integration (#2527).
 *
 * The budget only works if every pool hands its slots back when it is
 * destroyed. The first cut of the feature claimed slots on construction and
 * never released them, so the second MCP engine in a process sized its query
 * pool to zero — the regression pinned here.
 *
 * Also pinned: the query pool is lazy, so it must claim one slot per live
 * worker (not its whole cap up front), or a live query pool would starve the
 * parse pool a watcher sync builds in the same process.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ThreadBudget } from '../src/thread-budget';
import { ParseWorkerPool, type ParsePoolWorker } from '../src/extraction/parse-pool';
import { QueryPool, type PoolWorker } from '../src/mcp/query-pool';

const limit = (total: number) => ({ total, source: 'flag' as const });

class FakeParseWorker implements ParsePoolWorker {
  terminated = false;
  postMessage(): void { /* no grammars-loaded handshake needed */ }
  terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0); }
  on(): void { /* no events needed */ }
}

class FakeQueryWorker implements PoolWorker {
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  constructor(private readonly behavior: (m: unknown) => void = () => {}) {
    setTimeout(() => this.msgCb?.({ type: 'ready', ok: true }), 0);
  }
  postMessage(m: unknown): void { this.behavior(m); }
  terminate(): Promise<number> { this.exitCb?.(0); return Promise.resolve(0); }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
  }
}

const handles = new Set<{ destroy(): Promise<void> }>();
afterEach(async () => {
  for (const pool of handles) await pool.destroy();
  handles.clear();
  vi.restoreAllMocks();
});

describe('ParseWorkerPool releases its thread lease', () => {
  function makePool(budget: ThreadBudget, size: number, created: FakeParseWorker[] = []): ParseWorkerPool {
    const lease = budget.lease(size);
    const pool = new ParseWorkerPool({
      languages: [],
      size: lease.size,
      createWorker: () => { const w = new FakeParseWorker(); created.push(w); return w; },
      loadSettleMs: 10,
      threadLease: lease,
    });
    handles.add(pool);
    return pool;
  }

  it('never runs more workers than it leased', () => {
    const budget = new ThreadBudget(limit(10));
    const created: FakeParseWorker[] = [];
    const pool = makePool(budget, 3, created);
    pool.prewarm();
    expect(pool.size).toBe(3);
    expect(created).toHaveLength(3);
    expect(budget.claimed).toBe(3);
  });

  it('returns the slots on destroy, so a later pool is not starved', async () => {
    const budget = new ThreadBudget(limit(4));
    const first = makePool(budget, 4);
    expect(budget.claimed).toBe(4);
    await first.destroy();
    expect(budget.claimed).toBe(0);

    const second = makePool(budget, 4);
    expect(second.size).toBe(4);
    expect(budget.claimed).toBe(4);
  });

  it('releases only once, however many times destroy is called', async () => {
    const budget = new ThreadBudget(limit(4));
    const pool = makePool(budget, 2);
    await pool.destroy();
    await pool.destroy();
    expect(budget.claimed).toBe(0);
  });
});

describe('QueryPool claims one slot per live worker', () => {
  it('does not reserve its whole cap up front', async () => {
    const budget = new ThreadBudget(limit(8));
    const pool = new QueryPool({ root: '/x', size: 8, threadBudget: budget, createWorker: () => new FakeQueryWorker() });
    handles.add(pool);
    expect(pool.liveWorkers).toBe(1);
    expect(budget.claimed).toBe(1);
  });

  it('stops growing at the budget and returns every slot on destroy', async () => {
    const budget = new ThreadBudget(limit(2));
    const pool = new QueryPool({
      root: '/x', size: 6, softTimeoutMs: 10_000, threadBudget: budget,
      createWorker: () => new FakeQueryWorker(() => { /* leave calls in flight to force growth */ }),
    });
    handles.add(pool);
    await vi.waitFor(() => expect(pool.ready).toBe(true));
    const calls = Array.from({ length: 4 }, () => pool.run('codegraph_status', {}));
    await vi.waitFor(() => expect(pool.liveWorkers).toBe(2));
    expect(budget.claimed).toBe(2);
    // A third worker would exceed the run's ceiling — it is not spawned.
    expect(pool.liveWorkers).toBeLessThan(pool.size);
    await pool.destroy();
    expect(budget.claimed).toBe(0);
    expect(pool.liveWorkers).toBe(0);
    await Promise.all(calls); // destroy answers the queued calls
  });

  it('a pool that cannot get a slot serves with what it has instead of exceeding the cap', async () => {
    const budget = new ThreadBudget(limit(1));
    const held = budget.lease(1);
    const pool = new QueryPool({ root: '/x', size: 4, threadBudget: budget, createWorker: () => new FakeQueryWorker() });
    handles.add(pool);
    expect(pool.liveWorkers).toBe(0); // eager worker could not be afforded
    expect(budget.claimed).toBe(1);
    await pool.destroy();
    expect(budget.claimed).toBe(1); // still the other pool's slot
    held.release();
    expect(budget.claimed).toBe(0);
  });
});
