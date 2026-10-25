/**
 * Shared thread budget (#2527): one user-facing ceiling on worker threads
 * across the parse, resolution and query pools together.
 *
 * Two things are pinned here because both are easy to break silently:
 *   - precedence (`--threads` > `codegraph.json` `maxThreads` >
 *     `CODEGRAPH_MAX_THREADS` > headroom default), including the rule that a
 *     malformed value falls through to the next source instead of disabling
 *     pooling or exploding the budget;
 *   - the ceiling is on the COMBINED total of the pools a run constructs, and
 *     the default never shrinks a pool below its own un-capped size (1 parse
 *     worker measured 34% slower than 2 on a 2-core envelope — see
 *     `extraction/index.ts`, so that would be a real regression).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  allocatePoolSizes,
  describeThreadBudget,
  DEFAULT_HEADROOM_CORES,
  resolveThreadLimit,
  resetThreadBudget,
  threadBudget,
  ThreadBudget,
} from '../src/thread-budget';

afterEach(() => {
  resetThreadBudget();
  delete process.env.CODEGRAPH_CLI_THREADS;
  delete process.env.CODEGRAPH_MAX_THREADS;
});

describe('resolveThreadLimit', () => {
  it('defaults to leaving headroom: cores minus two', () => {
    expect(DEFAULT_HEADROOM_CORES).toBe(2);
    expect(resolveThreadLimit({ availableParallelism: 18 })).toEqual({ total: 16, source: 'default' });
    expect(resolveThreadLimit({ availableParallelism: 8 })).toEqual({ total: 6, source: 'default' });
    expect(resolveThreadLimit({ availableParallelism: 4 })).toEqual({ total: 2, source: 'default' });
  });

  it('never resolves below 1, even on a single-core box', () => {
    expect(resolveThreadLimit({ availableParallelism: 1 }).total).toBe(1);
    expect(resolveThreadLimit({ availableParallelism: 0 }).total).toBe(1);
    expect(resolveThreadLimit({ availableParallelism: -3 }).total).toBe(1);
  });

  it('keeps the default at or above a pool\'s own request (no single-pool regression)', () => {
    // A 2-core box gives the parse pool 2 workers today; the shared budget must
    // not be what takes it to 1.
    const limit = resolveThreadLimit({ availableParallelism: 2, minimum: 2 });
    expect(limit).toEqual({ total: 2, source: 'default' });
    // The floor widens the default, it does not cap it.
    expect(resolveThreadLimit({ availableParallelism: 18, minimum: 8 }).total).toBe(16);
    expect(resolveThreadLimit({ availableParallelism: 3, minimum: 3 }).total).toBe(3);
  });

  it('precedence: --threads beats codegraph.json beats CODEGRAPH_MAX_THREADS', () => {
    const base = { availableParallelism: 18, minimum: 8 };
    expect(resolveThreadLimit({ ...base, envMaxThreads: '4', configMaxThreads: 6, cliThreads: 3 }))
      .toEqual({ total: 3, source: 'flag' });
    expect(resolveThreadLimit({ ...base, envMaxThreads: '4', configMaxThreads: 6 }))
      .toEqual({ total: 6, source: 'config' });
    expect(resolveThreadLimit({ ...base, envMaxThreads: '4' }))
      .toEqual({ total: 4, source: 'env' });
  });

  it('ignores malformed values and falls through to the next source', () => {
    const base = { availableParallelism: 18, minimum: 8 };
    for (const bad of ['0', '-1', '2.5', 'abc', '', '  ']) {
      expect(resolveThreadLimit({ ...base, cliThreads: bad, configMaxThreads: 6, envMaxThreads: '4' }))
        .toEqual({ total: 6, source: 'config' });
      expect(resolveThreadLimit({ ...base, configMaxThreads: Number(bad) || 0, envMaxThreads: '4' }))
        .toEqual({ total: 4, source: 'env' });
      expect(resolveThreadLimit({ ...base, envMaxThreads: bad }))
        .toEqual({ total: 16, source: 'default' });
    }
    expect(resolveThreadLimit({ ...base, configMaxThreads: 2.5 }).source).toBe('default');
    expect(resolveThreadLimit({ ...base, configMaxThreads: 0 }).source).toBe('default');
  });

  it('accepts the numeric form a typed config delivers as well as strings', () => {
    expect(resolveThreadLimit({ availableParallelism: 18, cliThreads: 5 }).total).toBe(5);
    expect(resolveThreadLimit({ availableParallelism: 18, configMaxThreads: 5 }).total).toBe(5);
    expect(resolveThreadLimit({ availableParallelism: 18, envMaxThreads: 5 as unknown as string }).total).toBe(5);
  });
});

describe('allocatePoolSizes', () => {
  it('grants every request in full when the budget is big enough', () => {
    expect(allocatePoolSizes(16, { parse: 8, resolve: 6 })).toEqual({ parse: 8, query: 0, resolve: 6 });
    expect(allocatePoolSizes(14, { parse: 8, resolve: 6 })).toEqual({ parse: 8, query: 0, resolve: 6 });
  });

  it('caps the COMBINED total of the pools that share a run', () => {
    const sizes = allocatePoolSizes(6, { parse: 8, resolve: 6 });
    expect(sizes.parse + sizes.resolve).toBe(6);
    expect(sizes.parse).toBeGreaterThan(0);
    expect(sizes.resolve).toBeGreaterThan(0);
  });

  it('scales every pool down proportionally — no pool is starved by an earlier one', () => {
    // 8 + 16 + 6 = 30 wanted, 15 granted: each pool keeps its share.
    const sizes = allocatePoolSizes(15, { parse: 8, query: 16, resolve: 6 });
    expect(sizes.parse + sizes.query + sizes.resolve).toBe(15);
    expect(sizes.query).toBeGreaterThan(sizes.parse);
    expect(sizes.parse).toBeGreaterThan(sizes.resolve);
  });

  it('hands the rounding slack back one slot at a time and never above a request', () => {
    const sizes = allocatePoolSizes(5, { parse: 3, resolve: 3 });
    expect(sizes.parse + sizes.resolve).toBe(5);
    expect(sizes.parse).toBeLessThanOrEqual(3);
    expect(sizes.resolve).toBeLessThanOrEqual(3);
  });

  it('treats a sub-1 budget as 1 rather than a zero-worker run', () => {
    expect(allocatePoolSizes(0, { parse: 8 })).toEqual({ parse: 1, query: 0, resolve: 0 });
    expect(allocatePoolSizes(-4, { parse: 8, resolve: 6 })).toEqual({ parse: 1, query: 0, resolve: 0 });
    expect(allocatePoolSizes(2.7, { parse: 8, resolve: 6 }).parse).toBe(2);
  });

  it('ignores absent and non-positive requests', () => {
    expect(allocatePoolSizes(16, {})).toEqual({ parse: 0, query: 0, resolve: 0 });
    expect(allocatePoolSizes(16, { parse: 0, resolve: -2 })).toEqual({ parse: 0, query: 0, resolve: 0 });
  });
});

describe('ThreadBudget', () => {
  const limit = { total: 10, source: 'flag' as const };

  it('never lets the pools it serves exceed the ceiling together', () => {
    const budget = new ThreadBudget(limit);
    expect(budget.claim(8)).toBe(8);
    expect(budget.claim(6)).toBe(2);
    expect(budget.remaining).toBe(0);
    expect(budget.claim(4)).toBe(0);
    expect(budget.claimed).toBe(10);
  });

  it('hands released slots back to the next pool', () => {
    const budget = new ThreadBudget(limit);
    budget.claim(8);
    budget.release(5);
    // 10 granted of 8 held → 3 still held, so 7 are free again.
    expect(budget.remaining).toBe(7);
    expect(budget.claim(6)).toBe(6);
    expect(budget.remaining).toBe(1);
  });

  it('ignores nonsensical claims and releases', () => {
    const budget = new ThreadBudget(limit);
    expect(budget.claim(-3)).toBe(0);
    expect(budget.claim(Number.NaN)).toBe(0);
    expect(budget.claimed).toBe(0);
    budget.claim(4);
    budget.release(-100);
    expect(budget.claimed).toBe(4);
    budget.release(999);
    expect(budget.claimed).toBe(0);
    expect(budget.remaining).toBe(10);
  });
});

describe('threadBudget (run-scoped)', () => {
  it('is created once per run and reuses the first resolved limit', () => {
    process.env.CODEGRAPH_CLI_THREADS = '3';
    const first = threadBudget();
    process.env.CODEGRAPH_CLI_THREADS = '9';
    expect(threadBudget().limit.total).toBe(3);
    expect(threadBudget()).toBe(first);
  });

  it('re-resolves after resetThreadBudget()', () => {
    process.env.CODEGRAPH_CLI_THREADS = '3';
    expect(threadBudget().limit.total).toBe(3);
    resetThreadBudget();
    process.env.CODEGRAPH_CLI_THREADS = '9';
    expect(threadBudget().limit.total).toBe(9);
  });

  it('accepts an explicit limit on first use', () => {
    const budget = threadBudget({ total: 7, source: 'config' });
    expect(budget.limit).toEqual({ total: 7, source: 'config' });
  });
});

describe('describeThreadBudget', () => {
  it('names each pool, the spend and where the limit came from', () => {
    const line = describeThreadBudget(
      { total: 16, source: 'default' },
      { parse: 8, query: 0, resolve: 6 },
      { cores: 18 },
    );
    expect(line).toBe('threads: parse=8 resolve=6 (14 of 16; source=default, 18 cores)');
  });

  it('can report a single pool', () => {
    const line = describeThreadBudget(
      { total: 12, source: 'flag' },
      { parse: 12, query: 0, resolve: 0 },
      { cores: 18, pools: ['parse'] },
    );
    expect(line).toBe('threads: parse=12 (12 of 12; source=flag, 18 cores)');
  });
});
