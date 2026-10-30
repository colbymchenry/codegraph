import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveIndexer } from '../../src/scip/indexers';
import { planRuns, projectWeights, tsProjects } from '../../src/scip/indexers/typescript';
import { writeConfig } from './helpers';

/** How the indexer is found and run: the commands, and the runs a repo splits into. */

describe('scip-typescript adapter', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-adapters-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('TS: one run per tsconfig/jsconfig project (node_modules ignored), a single project stays one run', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    writeConfig(dir, { typescript: { cmd: process.execPath } });
    expect(resolveIndexer(dir, 'typescript', out)).toMatchObject({ runs: [{ label: 'typescript', output: out }] });

    for (const p of ['src', 'extensions/git', 'extensions/web', 'node_modules/dep']) fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/git/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/web/jsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'node_modules/dep/tsconfig.json'), '{}');
    expect(tsProjects(dir)).toEqual(['.', 'extensions/git', 'extensions/web', 'src']);
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    // All light: tsconfig projects share one batch (retried one by one if it fails); jsconfig ones infer theirs.
    expect(r.runs.map(x => x.args.slice(3))).toEqual([['.', 'extensions/git', 'src'], ['extensions/web', '--infer-tsconfig']]);
    expect(r.runs[0]!.fallback?.map(f => f.label)).toEqual(['.', 'extensions/git', 'src']);
    expect(r.runs.every(x => x.light && /--max-old-space-size=\d+/.test(x.env?.NODE_OPTIONS ?? ''))).toBe(true);
  });

  it('TS: heavy projects run alone with the big heap, light ones are batched by size', () => {
    const projects = ['core', 'a', 'b', 'c'];
    const weights = new Map([['core', 5000], ['a', 900], ['b', 900], ['c', 10]]);
    for (const p of projects) fs.mkdirSync(path.join(dir, p));
    for (const p of projects) fs.writeFileSync(path.join(dir, p, 'tsconfig.json'), '{}');
    const runs = planRuns(dir, projects, weights, path.join(dir, 'out'));
    expect(runs.map(r => [r.args.slice(3), !!r.light])).toEqual([
      [['core'], false], // heavy first, alone
      [['a'], true], // a + b would pass 1,500 files
      [['b', 'c'], true],
    ]);
    const heap = (r: typeof runs[number]) => Number(/--max-old-space-size=(\d+)/.exec(r.env?.NODE_OPTIONS ?? '')?.[1]);
    if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) expect(heap(runs[0]!)).toBeGreaterThanOrEqual(heap(runs[1]!));
    expect(projectWeights(['.', 'src', 'src/sub'], ['a.ts', 'src/x.ts', 'src/sub/y.ts', 'src/sub/z.js', 'README.md']))
      .toEqual(new Map([['.', 1], ['src', 1], ['src/sub', 2]])); // each file counted for its deepest project
  });

  it('warns when a lockfile has no node_modules beside it, with the command that installs it', () => {
    const warning = () => {
      const r = resolveIndexer(dir, 'typescript', path.join(dir, 'out.tmp'));
      if ('skip' in r) throw new Error(r.skip);
      return r.warning;
    };
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    writeConfig(dir, { typescript: { cmd: process.execPath } });
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(warning()).toBeUndefined(); // installed
    fs.rmdirSync(path.join(dir, 'node_modules'));
    expect(warning()).toMatch(/pnpm-lock\.yaml but no node_modules — .* run `pnpm install` and reindex/);
  });

  it('an `{args}` override element splices in the adapter arguments', () => {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    writeConfig(dir, { typescript: { cmd: process.execPath, args: ['-y', '@sourcegraph/scip-typescript', '{args}'] } });
    const r = resolveIndexer(dir, 'typescript', path.join(dir, '.codegraph', 'scip', 'out.tmp'));
    expect('skip' in r ? r.skip : r.runs[0]!.args.slice(0, 3)).toEqual(['-y', '@sourcegraph/scip-typescript', 'index']);
  });
});
