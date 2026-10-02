import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { nextPatchRatio, produceIndex } from '../../src/scip/produce';
import { indexPath, scipDir } from '../../src/scip/store';
import { FIXTURES, FixtureProject, edgesBetween, fakeIndexer, fakeRuns, indexedFixture, merge, writeConfig } from './helpers';

/** Producing an index (src/scip/produce.ts): running the indexer, guarding what it installs, and reporting what it can't do. */
describe('produceIndex (fake TypeScript indexers)', () => {
  let p: FixtureProject;
  const produce = (opts?: Parameters<typeof produceIndex>[3]) => produceIndex(p.cg.scipReadDb(), p.dir, 'typescript', opts);

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('regression guard keeps the old index when resolution collapses; the swap is atomic', async () => {
    fakeIndexer(p.dir, 'index.scip');
    expect((await produce()).status).toBe('installed');
    const installed = fs.readFileSync(indexPath(p.dir, 'typescript'));

    fakeIndexer(p.dir, 'index-broken.scip'); // main.ts failed to compile away
    expect((await produce()).status).toBe('rejected');
    expect(fs.readFileSync(indexPath(p.dir, 'typescript')).equals(installed)).toBe(true);
    expect(fs.readdirSync(scipDir(p.dir)).filter(f => /\.(tmp|raw)$/.test(f))).toEqual([]);

    expect((await produce({ force: true })).status).toBe('installed');
  });

  it('a malformed codegraph.json or override is reported, never silently ignored', async () => {
    fs.writeFileSync(path.join(p.dir, 'codegraph.json'), '{ "scip": ');
    expect(await produce()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not valid JSON/) });
    writeConfig(p.dir, { typescript: { cmd: process.execPath, env: { N: 1 } } });
    expect(await produce()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/env/) });
    writeConfig(p.dir, { typescript: { cmd: 42 } });
    expect(await produce()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/cmd/) });
  });

  it('indexes a multi-project repo one project per process; a failed project is a warning, not a failure', async () => {
    for (const d of ['packages/a', 'packages/bad']) {
      fs.mkdirSync(path.join(p.dir, d), { recursive: true });
      fs.writeFileSync(path.join(p.dir, d, 'tsconfig.json'), '{}');
    }
    // Each run gets its own `{out}`; `{args}` carries the project dir, so the fake fails for one of them.
    writeConfig(p.dir, {
      typescript: {
        cmd: process.execPath,
        args: ['-e', 'const fs=require("fs");fs.appendFileSync(process.argv[3],"x");if(process.argv.includes("packages/bad"))process.exit(3);fs.copyFileSync(process.argv[1],process.argv[2])',
          path.join(FIXTURES, 'scip-ts', 'index.scip'), '{out}', path.join(p.dir, 'runs.log'), '{args}'],
      },
    });
    const r = await produce();
    expect(fakeRuns(p.dir)).toBe(4); // the light batch ('.', packages/a, packages/bad) fails, then each project alone
    expect(r).toMatchObject({ status: 'installed', documents: 2 }); // two copies of the same index, deduplicated
    expect(r.status === 'installed' && r.warnings).toEqual([expect.stringMatching(/^packages\/bad: .*exited 3/)]);
    expect(fs.readdirSync(scipDir(p.dir)).filter(f => /\.tmp|\.raw|\.part\d/.test(f))).toEqual([]);
    await merge(p);
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip');
  });

  it('a split run fails only when every project fails', async () => {
    fs.mkdirSync(path.join(p.dir, 'packages/a'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, 'packages/a/tsconfig.json'), '{}');
    writeConfig(p.dir, { typescript: { cmd: process.execPath, args: ['-e', 'process.exit(2)'] } });
    expect(await produce()).toMatchObject({ status: 'failed', reason: expect.stringMatching(/all 2 runs failed/) }); // both retried projects
  });

  it('skips (never installs) an indexer that is not on PATH', async () => {
    writeConfig(p.dir, { typescript: { cmd: 'definitely-not-a-scip-indexer' } });
    expect(await produce()).toMatchObject({ status: 'skipped' });
    writeConfig(p.dir, { typescript: false });
    expect(await produce()).toMatchObject({ status: 'skipped' });
  });
});

describe('patch ratio', () => {
  it('is measured ÷ declared, averaged with the last, bounded so a slow patch cannot price patches out for good', () => {
    expect(nextPatchRatio(undefined, 1000, 500)).toBe(0.5);
    expect(nextPatchRatio(0.5, 1000, 1500)).toBe(1);
    expect(nextPatchRatio(undefined, 1000, 60_000)).toBe(2);
    expect(nextPatchRatio(undefined, 1000, 1)).toBe(0.1);
    expect(nextPatchRatio(0.7, 0, 900)).toBe(0.7); // only deletions: nothing measured
  });
});
