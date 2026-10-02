import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { produceIndex } from '../../src/scip/produce';
import { ScipReindexScheduler } from '../../src/scip/reindex';
import { scipDir, tryReindexLock } from '../../src/scip/store';
import { FixtureProject, edgesBetween, fakeIndexer, fakeRuns, indexedFixture } from './helpers';

/** The watcher's background reindex (src/scip/reindex.ts) and the lock that keeps it to one per project. */
describe('background reindex', () => {
  let p: FixtureProject;
  const settle = () => new Promise(r => setTimeout(r, 80));
  /** An installed index from the fake indexer, then an edit for the next reindex to pick up. */
  const installedThenEdited = async (delayMs = 0) => {
    fakeIndexer(p.dir, 'index.scip');
    await produceIndex(p.cg.scipReadDb(), p.dir, 'typescript');
    fakeIndexer(p.dir, 'index.scip', delayMs);
    fs.writeFileSync(path.join(p.dir, 'src', 'extra.ts'), 'export const e = 1;\n');
    await p.cg.sync();
  };

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('background reindex waits for quiet, coalesces bursts, and respects the minimum interval', async () => {
    await installedThenEdited();
    const before = fakeRuns(p.dir);
    const s = new ScipReindexScheduler(p.cg, { idleMs: 30, minIntervalMs: 60_000, log: () => {} });
    try {
      s.notifyChange();
      s.notifyChange();
      await settle();
      await s.idle();
      expect(fakeRuns(p.dir) - before).toBe(1);
      expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip'); // merged after reindex

      s.notifyChange(); // inside the minimum interval
      await settle();
      await s.idle();
      expect(fakeRuns(p.dir) - before).toBe(1);
    } finally {
      s.stop();
    }
  });

  it('one reindex per project at a time: a second scheduler skips while the first runs', async () => {
    await installedThenEdited(300);
    const before = fakeRuns(p.dir);
    const logs: string[] = [];
    const a = new ScipReindexScheduler(p.cg, { idleMs: 30, minIntervalMs: 60_000, log: () => {} });
    const b = new ScipReindexScheduler(p.cg, { idleMs: 30, minIntervalMs: 60_000, log: m => logs.push(m) });
    try {
      a.notifyChange();
      await settle(); // a is inside its indexer run
      b.notifyChange();
      await settle();
      await Promise.all([a.idle(), b.idle()]);
      expect(fakeRuns(p.dir) - before).toBe(1);
      expect(logs.some(m => m.includes('reindex skipped'))).toBe(true);
      expect(tryReindexLock(p.dir)?.release()).toBeUndefined(); // released afterwards
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('the reindex lock is exclusive and a dead holder\'s lock is taken over', () => {
    const held = tryReindexLock(p.dir)!;
    expect(held).not.toBeNull();
    expect(tryReindexLock(p.dir)).toBeNull();
    held.release();
    fs.writeFileSync(path.join(scipDir(p.dir), 'reindex.lock'), '2147483646'); // no such pid
    const taken = tryReindexLock(p.dir);
    expect(taken).not.toBeNull();
    taken!.release();
  });
});
