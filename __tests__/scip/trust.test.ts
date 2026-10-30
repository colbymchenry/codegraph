import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importScipFile, mergePass } from '../../src/scip';
import { resolveIndexer } from '../../src/scip/indexers';
import { produceIndex } from '../../src/scip/produce';
import { indexPath } from '../../src/scip/store';
import { configDigest, trustFilePath, trustProject, trustState } from '../../src/scip/trust';
import { FIXTURES, FixtureProject, edgesBetween, fakeIndexer, fakeRuns, indexedFixture, writeConfig } from './helpers';

/** Indexers run only in a project the user trusted, and only while its `scip` block is what they trusted. */

const BIN = path.resolve(__dirname, '../../dist/bin/codegraph.js');

describe('workspace trust for SCIP indexers', () => {
  let p: FixtureProject;
  const produce = () => produceIndex(p.cg.scipReadDb(), p.dir, 'typescript');
  const untrust = () => fs.rmSync(trustFilePath(), { force: true });
  const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, 'scip', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => { untrust(); p.close(); });

  it('an untrusted project runs no indexer, whatever its codegraph.json says', async () => {
    fakeIndexer(p.dir, 'index.scip');
    untrust();
    expect(await produce()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not trusted to run SCIP indexers/) });
    expect(fakeRuns(p.dir)).toBe(0);
    expect(fs.existsSync(indexPath(p.dir, 'typescript'))).toBe(false);
  });

  it('an edit to the scip block stops the indexer until the project is trusted again', async () => {
    fakeIndexer(p.dir, 'index.scip');
    expect(await produce()).toMatchObject({ status: 'installed' });
    expect(fakeRuns(p.dir)).toBe(1);

    const config = JSON.parse(fs.readFileSync(path.join(p.dir, 'codegraph.json'), 'utf8'));
    config.scip.typescript.env = { EXTRA: '1' };
    fs.writeFileSync(path.join(p.dir, 'codegraph.json'), JSON.stringify(config));
    expect(await produce()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/scip block changed since you trusted/) });
    expect(fakeRuns(p.dir)).toBe(1);

    trustProject(p.dir);
    expect(await produce()).toMatchObject({ status: 'installed' });
    expect(fakeRuns(p.dir)).toBe(2);
  });

  it('an edit outside the scip block, or to its key order, keeps the trust', () => {
    writeConfig(p.dir, { typescript: { cmd: process.execPath, env: { A: '1', B: '2' } } });
    const file = path.join(p.dir, 'codegraph.json');
    fs.writeFileSync(file, JSON.stringify({ exclude: ['vendor/'], scip: { typescript: { env: { B: '2', A: '1' }, cmd: process.execPath } } }));
    expect(trustState(p.dir)).toBe('trusted');
  });

  it('is kept per project, outside it', async () => {
    writeConfig(p.dir, { typescript: { cmd: process.execPath } });
    const other = await indexedFixture('scip-ts');
    try {
      writeConfig(other.dir, { typescript: { cmd: process.execPath } }, false);
      expect(trustState(other.dir)).toBe('untrusted');
      expect(trustFilePath().startsWith(os.homedir())).toBe(true);
      expect(trustFilePath().startsWith(p.dir)).toBe(false);
    } finally {
      other.close();
    }
  });

  it('a trust file that cannot be parsed is reported, never taken as trust', () => {
    writeConfig(p.dir, { typescript: { cmd: process.execPath } });
    fs.writeFileSync(trustFilePath(), '{ "projects": ');
    expect(resolveIndexer(p.dir, 'typescript', path.join(p.dir, 'out.tmp'))).toEqual({ skip: expect.stringMatching(/is not valid JSON/) });
  });

  it('digests the same config the same way, whatever the key order', () => {
    expect(configDigest({ a: 1, b: { c: [1, 2], d: null } })).toBe(configDigest({ b: { d: null, c: [1, 2] }, a: 1 }));
    expect(configDigest({ a: [1, 2] })).not.toBe(configDigest({ a: [2, 1] }));
  });

  it('`scip index` without a terminal refuses an untrusted project unless --trust is passed', () => {
    fakeIndexer(p.dir, 'index.scip');
    untrust();
    p.cg.close();
    const run = (...flags: string[]) => cli('index', p.dir, ...flags);

    const refused = run();
    expect(refused.status).toBe(1);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/pass --trust/);
    expect(fakeRuns(p.dir)).toBe(0);

    const allowed = run('--trust');
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(fakeRuns(p.dir)).toBe(1);
    expect(trustState(p.dir)).toBe('trusted');
  });

  it('an index shipped inside an untrusted project never reaches its graph', async () => {
    const added = () => edgesBetween(p.cg.scipReadDb(), 'sum', 'Invoice::totalPrice', ['calls']); // a call only SCIP finds
    const shipped = path.join(p.dir, 'shipped.scip');
    fs.copyFileSync(path.join(FIXTURES, 'scip-ts', 'index.scip'), shipped);
    importScipFile(p.dir, shipped); // installed as a committed .codegraph/scip/ would be: no trust asked
    untrust();
    await p.cg.indexAll();
    expect(added()).toEqual([]);

    trustProject(p.dir);
    await p.cg.indexAll();
    expect(added()).toMatchObject([{ provenance: 'scip' }]);

    writeConfig(p.dir, { typescript: false }, false); // the block changed since it was trusted: merges pause
    expect(await p.cg.scipWrite(db => mergePass(db, p.cg.scipDbPath(), p.dir))).toBeNull();
  });

  it('`scip import` without a terminal refuses an untrusted project unless --trust is passed', () => {
    untrust();
    p.cg.close();
    const index = path.join(FIXTURES, 'scip-ts', 'index.scip');
    const refused = cli('import', index, p.dir);
    expect(refused.status).toBe(1);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/pass --trust/);
    expect(fs.existsSync(indexPath(p.dir, 'typescript'))).toBe(false);

    const allowed = cli('import', index, p.dir, '--trust');
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toMatch(/documents merged/);
  });
});
