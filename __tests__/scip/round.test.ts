import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reindexRound } from '../../src/scip/round';
import { needsMerge } from '../../src/scip/store';
import { FixtureProject, edgesBetween, importFixtureIndex, indexedFixture, writeConfig } from './helpers';

/** One produce→merge round (src/scip/round.ts): no install left unmerged when an indexer fails. */
describe('reindexRound', () => {
  let p: FixtureProject;

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('merges an index still awaiting a merge, even when the indexer fails', async () => {
    importFixtureIndex(p, 'scip-ts'); // installed, never merged: an earlier round crashed before its merge
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(true);
    writeConfig(p.dir, { typescript: { cmd: process.execPath, args: ['-e', 'process.exit(2)'] } });
    const { results, report } = await reindexRound(p.cg, { langs: ['typescript'] });
    expect(results.map(r => r.status)).toEqual(['failed']);
    expect(report).not.toBeNull();
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip');
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(false);
  });
});
