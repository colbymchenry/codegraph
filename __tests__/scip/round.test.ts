import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mergeInstalled } from '../../src/scip';
import { produceIndex } from '../../src/scip/produce';
import { reindexRound } from '../../src/scip/round';
import { indexPath, needsMerge, readMeta } from '../../src/scip/store';
import { Compactor } from '../../src/scip/compact';
import { loadScipIndex } from '../../src/scip/reader';
import { referenceSites } from '../../src/scip/sites';
import { FixtureProject, FIXTURES, edgesBetween, fakeIndexer, indexedFixture, writeConfig } from './helpers';

/** One produce→merge round (src/scip/round.ts): no install left unmerged when a later language fails. */
describe('reindexRound', () => {
  let p: FixtureProject;

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('merges an earlier language when a later one fails', async () => {
    fs.writeFileSync(path.join(p.dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    writeConfig(p.dir, {
      typescript: {
        cmd: process.execPath,
        args: ['-e', 'const fs=require("fs");fs.copyFileSync(process.argv[1],process.argv[2])',
          path.join(FIXTURES, 'scip-ts', 'index.scip'), '{out}'],
      },
      python: {
        cmd: process.execPath,
        args: ['-e', 'require("fs").mkdirSync(process.argv[1]); process.exit(2)', '{out}'],
      },
    });
    const { results, report } = await reindexRound(p.cg, { langs: ['typescript', 'python'] });
    expect(results.map(r => r.status)).toEqual(['installed', 'failed']);
    expect(report).not.toBeNull();
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip');
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(false);
  });

  it('heals an install that never reached merge: --changed current still merges', async () => {
    fakeIndexer(p.dir, 'index.scip');
    expect((await produceIndex(p.cg.scipReadDb(), p.dir, 'typescript')).status).toBe('installed');
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(true);
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).not.toBe('scip');

    // Same bytes as the snapshot → produce says current; old mergeInstalled would skip.
    const { results, report } = await reindexRound(p.cg, { langs: ['typescript'], incremental: true });
    expect(results).toEqual([{ status: 'current', lang: 'typescript' }]);
    expect(report).not.toBeNull();
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip');
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(false);

    // A second current round does not re-merge for nothing.
    const again = await mergeInstalled(p.cg, [{ status: 'current', lang: 'typescript' }]);
    expect(again).toBeNull();
  });
});

describe('a patch on an install never merged', () => {
  let p: FixtureProject;
  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  /**
   * Installed (unmerged or merged), then an edit a patch can take: a project to re-index
   * alone (more projects than one batch holds, so the full run has per-project runs to
   * take it from), and a slow last full run that makes a patch worth it.
   */
  const patchAfterInstall = async (mergeFirst: boolean) => {
    for (let i = 0; i < 17; i++) {
      fs.mkdirSync(path.join(p.dir, 'packages', `p${i}`), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'packages', `p${i}`, 'tsconfig.json'), '{}');
    }
    fakeIndexer(p.dir, 'index.scip');
    expect((await produceIndex(p.cg.scipReadDb(), p.dir, 'typescript')).status).toBe('installed');
    if (mergeFirst) await mergeInstalled(p.cg, [{ status: 'current', lang: 'typescript' }]);
    const meta = path.join(p.dir, '.codegraph', 'scip', 'typescript.meta.json');
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), fullRunMs: 3_600_000 }));
    fs.writeFileSync(path.join(p.dir, 'packages', 'p0', 'extra.ts'), 'export const e = 1;\n');
    await p.cg.sync();
    return produceIndex(p.cg.scipReadDb(), p.dir, 'typescript', { incremental: true });
  };

  it('is merged in full: a scope would mark the unmerged documents merged without judging them', async () => {
    const r = await patchAfterInstall(false);
    expect(r).toMatchObject({ status: 'installed', incremental: 1 });
    expect(r.status === 'installed' && r.scope).toBeUndefined();
    await mergeInstalled(p.cg, [r]);
    expect(edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls'])[0]?.provenance).toBe('scip');
    expect(needsMerge(p.cg.scipReadDb(), p.dir)).toBe(false);
  });

  it('keeps the untouched documents as they are: the same index and resolved calls as compacting every document again', async () => {
    const r = await patchAfterInstall(true);
    expect(r).toMatchObject({ status: 'installed', incremental: 1 });
    expect(readMeta(p.dir, 'typescript')?.callMarks).toBe(true);
    const installed = fs.readFileSync(indexPath(p.dir, 'typescript'));
    const again = new Compactor(p.dir, 'typescript', referenceSites(p.cg.scipReadDb()));
    const { documents, toolName, toolVersion } = loadScipIndex(indexPath(p.dir, 'typescript'));
    again.addDocuments({ toolName, toolVersion, projectRoot: '' }, documents);
    const out = path.join(p.dir, 'again.scip');
    again.write(out);
    expect(r.status === 'installed' && r.resolvedCalls).toBe(again.resolvedCalls());
    expect(fs.readFileSync(out).equals(installed)).toBe(true);
  });

  it('keeps its scope when the index under it was merged', async () => {
    const r = await patchAfterInstall(true);
    expect(r).toMatchObject({ status: 'installed', incremental: 1 });
    expect(r.status === 'installed' && r.scope?.files).toContain('packages/p0/extra.ts');
  });
});
