/**
 * Resolver-pool sizing (§7a.1 P1.2): cgroup-honest CPU term + memory-aware
 * cap + the CODEGRAPH_RESOLVE_WORKERS override. resolvePoolSize is pure —
 * these pin the whole decision matrix, including the two failure modes the
 * measurement round exposed: os.cpus() cpuset-blindness (6 workers inside a
 * 2-CPU container) and memory-blind sizing (six ~1GB workers OOM-killing a
 * 7GB container at true 8-core concurrency).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { ResolverPool } from '../src/resolution/resolver-pool';
import {
  cgroupMemoryAvailable,
  darwinMemoryAvailable,
  memoryBudgetBytes,
} from '../src/resolution/memory-budget';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function size(opts: Partial<Parameters<typeof ResolverPool.resolvePoolSize>[0]>): number | null {
  return ResolverPool.resolvePoolSize({
    availableParallelism: 8,
    memoryBudget: 16 * GB,
    dbSizeBytes: 200 * MB,
    ...opts,
  });
}

describe('ResolverPool.resolvePoolSize', () => {
  it('big dev box: CPU-capped at the long-standing 6', () => {
    expect(size({})).toBe(6);
    expect(size({ availableParallelism: 11 })).toBe(6);
  });

  it('true 2-core box gets NO pool — sequential measured faster there (§7a.1: 853s vs 1150s)', () => {
    expect(size({ availableParallelism: 2, memoryBudget: 6 * GB })).toBeNull();
    expect(size({ availableParallelism: 3, memoryBudget: 6 * GB })).toBe(2);
  });

  it('kernel-scale DB in a 7GB container: memory term shrinks the pool below the OOM line', () => {
    // 4.6GB DB → ~940MB/worker estimate; 5.5GB headroom × 0.7 ≈ 3.85GB → 4 workers.
    const s = size({ availableParallelism: 8, memoryBudget: 5.5 * GB, dbSizeBytes: 4.6 * GB });
    expect(s).toBe(4);
    expect(s!).toBeLessThan(6);
  });

  it('per-worker estimate is floored (small DBs) and capped (huge DBs)', () => {
    // Small DB: floor 256MB/worker — memory cap = 16GB*0.7/256MB = 43 → CPU wins.
    expect(size({ dbSizeBytes: 10 * MB })).toBe(6);
    // Monster DB: cap 1.5GB/worker — 16GB*0.7/1.5GB = 7 → CPU still wins at 6.
    expect(size({ dbSizeBytes: 40 * GB })).toBe(6);
    // Same monster DB, tight memory: 4GB*0.7/1.5GB = 1 → below 2 → no pool.
    expect(size({ dbSizeBytes: 40 * GB, memoryBudget: 4 * GB })).toBeNull();
  });

  it('starved memory disables the pool entirely', () => {
    expect(size({ memoryBudget: 512 * MB, dbSizeBytes: 4 * GB })).toBeNull();
  });

  it('CODEGRAPH_RESOLVE_WORKERS overrides everything: 0 disables, values clamp at 16', () => {
    expect(size({ explicit: '0' })).toBeNull();
    expect(size({ explicit: '3', memoryBudget: 512 * MB })).toBe(3); // override skips the memory term
    expect(size({ explicit: '64' })).toBe(16);
    expect(size({ explicit: 'nonsense' })).toBe(6); // unparseable → computed path
  });
});

describe('memory budget helpers', () => {
  it('memoryBudgetBytes is positive and finite on every platform', () => {
    const b = memoryBudgetBytes();
    expect(b).toBeGreaterThan(0);
    expect(Number.isFinite(b)).toBe(true);
  });

  it('cgroupMemoryAvailable is null when uncontained (non-Linux) and never throws', () => {
    const v = cgroupMemoryAvailable();
    if (process.platform !== 'linux') {
      expect(v).toBeNull();
    } else {
      // Containerized CI: either uncontained (null) or a sane byte count.
      expect(v === null || (v >= 0 && Number.isFinite(v))).toBe(true);
    }
  });

  it.runIf(process.platform === 'darwin')(
    'darwin: available memory counts reclaimable pages, not just free_count',
    () => {
      const v = darwinMemoryAvailable();
      // vm_stat exists on every macOS; a null here means the parse broke.
      expect(v).not.toBeNull();
      expect(Number.isFinite(v!)).toBe(true);
      // The sum includes the free pages freemem() counts, so it can only be
      // larger (modulo TOCTOU drift between the two reads — allow slack).
      expect(v!).toBeGreaterThanOrEqual(os.freemem() * 0.5);
      // And the budget must ride it (the 2-worker strangulation regression:
      // a mostly-idle Mac read ~1GB free and halved the resolver pool).
      expect(memoryBudgetBytes()).toBeGreaterThanOrEqual(v! * 0.5);
    }
  );

  it.runIf(process.platform !== 'darwin')(
    'darwinMemoryAvailable is null off-macOS and never throws',
    () => {
      expect(darwinMemoryAvailable()).toBeNull();
    }
  );
});
