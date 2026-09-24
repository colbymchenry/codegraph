import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// Wrap only I/O entry points for deterministic failure injection; all other
// calls, files, parser work and SQLite remain real.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  // openSync too: a bounded source reader opens a descriptor instead of
  // calling readFileSync, and the injected read failure must reach either.
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
});
// The real entry points, for the injecting implementations to fall through to
// and for afterEach to reinstate. Under Vitest 4 `vi.spyOn` on a mocked
// module's export returns the same `vi.fn`, so reading `cp.execFileSync` inside
// a test and calling it from the injected implementation recurses into itself,
// and `vi.restoreAllMocks()` no longer resets a `vi.fn`'s implementation.
const actualCp = await vi.importActual<typeof import('child_process')>('child_process');
const actualFs = await vi.importActual<typeof import('fs')>('fs');
const injectExecFileSync = (impl: (real: typeof cp.execFileSync, ...args: any[]) => unknown) =>
  vi.mocked(cp.execFileSync).mockImplementation(((...args: any[]) => impl(actualCp.execFileSync, ...args)) as typeof cp.execFileSync);
const injectReadFileSync = (impl: (real: typeof fs.readFileSync, ...args: any[]) => unknown) =>
  vi.mocked(fs.readFileSync).mockImplementation(((...args: any[]) => impl(actualFs.readFileSync, ...args)) as typeof fs.readFileSync);
const injectOpenSync = (impl: (real: typeof fs.openSync, ...args: any[]) => unknown) =>
  vi.mocked(fs.openSync).mockImplementation(((...args: any[]) => impl(actualFs.openSync, ...args)) as typeof fs.openSync);
const reinstateIo = () => {
  vi.mocked(cp.execFileSync).mockImplementation(actualCp.execFileSync as typeof cp.execFileSync);
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync as typeof fs.readFileSync);
  vi.mocked(fs.openSync).mockImplementation(actualFs.openSync as typeof fs.openSync);
};

describe('git index currency across commits and restores (#1829)', () => {
  let root: string;
  let cg: CodeGraph;
  const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (name: string, symbol: string) => fs.writeFileSync(path.join(root, name), `export function ${symbol}() { return 1; }\n`);
  const commit = () => { git('add', '-A'); git('commit', '-m', 'change'); return git('rev-parse', 'HEAD').trim(); };
  const metadata = () => (cg as any).queries;
  const symbols = (name: string) => cg.searchNodes(name).map(r => r.node.name);
  const clean = () => expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-currency-'));
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    write('source.ts', 'original'); commit();
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
  });
  afterEach(() => { reinstateIo(); vi.restoreAllMocks(); cg?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each(['index', 'sync', 'scoped'] as const)('sees a restored indexed dirty edit after %s', async mode => {
    write('source.ts', 'dirtyVersion');
    if (mode === 'index') await cg.indexAll();
    else await cg.sync(mode === 'scoped' ? { paths: ['source.ts'] } : {});
    expect(symbols('dirtyVersion')).toContain('dirtyVersion');
    git('restore', 'source.ts');
    expect(git('status', '--porcelain')).toBe('');
    // Reopen proves that dirty candidates survive beyond one engine instance.
    cg.close(); cg = CodeGraph.openSync(root);
    expect(cg.getChangedFiles().modified).toEqual(['source.ts']);
    await cg.sync();
    expect(symbols('original')).toContain('original');
    expect(symbols('dirtyVersion')).not.toContain('dirtyVersion'); clean();
  });

  it.each(['index', 'sync'] as const)('does not claim a commit made during %s maintenance', async mode => {
    const oldHead = git('rev-parse', 'HEAD').trim();
    write('source.ts', 'firstEdit');
    const db = (cg as any).db;
    const maintain = db.runMaintenance.bind(db);
    const spy = vi.spyOn(db, 'runMaintenance').mockImplementationOnce(async () => {
      write('source.ts', 'lateCommit'); commit();
      return maintain();
    });
    if (mode === 'index') await cg.indexAll(); else await cg.sync();
    expect(spy).toHaveBeenCalledOnce();
    expect(metadata().getMetadata('indexed_at_commit')).toBe(oldHead);
    expect(cg.getChangedFiles().modified).toEqual(['source.ts']);
    await cg.sync(); expect(symbols('lateCommit')).toContain('lateCommit'); clean();
  });

  it('handles non-ASCII and quoted committed paths without git text escaping', async () => {
    const names = ['тест.ts', 'space name.ts'];
    if (process.platform !== 'win32') names.push('quote"name.ts');
    for (const file of names) write(file, 'newSymbol');
    commit();
    expect(cg.getChangedFiles().added.sort()).toEqual(names.sort());
    await cg.sync(); clean();
    fs.renameSync(path.join(root, 'тест.ts'), path.join(root, 'renamed.ts')); commit();
    expect(cg.getChangedFiles()).toEqual({ added: ['renamed.ts'], modified: [], removed: ['тест.ts'] });
  });

  it('falls back when git diff fails instead of claiming a clean index', () => {
    write('new.ts', 'newSymbol'); commit();
    let injected = 0;
    injectExecFileSync((real, file: string, args: string[], options: any) => {
      if (file === 'git' && args[0] === 'diff') { injected++; throw new Error('Injected git diff timeout'); }
      return real(file, args, options);
    });
    expect(cg.getChangedFiles().added).toEqual(['new.ts']);
    expect(injected).toBeGreaterThan(0);
  });

  it('does not advance the commit stamp after a scoped sync', async () => {
    const oldHead = metadata().getMetadata('indexed_at_commit');
    write('one.ts', 'one'); write('two.ts', 'two'); commit();
    await cg.sync({ paths: ['one.ts'] });
    expect(metadata().getMetadata('indexed_at_commit')).toBe(oldHead);
    expect(cg.getChangedFiles().added).toEqual(['two.ts']);
    await cg.sync(); clean();
  });

  it('retains a restored dirty path when a later scoped sync touches another file', async () => {
    write('source.ts', 'dirtyVersion'); await cg.sync();
    git('restore', 'source.ts'); write('other.ts', 'other');
    await cg.sync({ paths: ['other.ts'] });
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: ['source.ts'], removed: [] });
    await cg.sync(); expect(symbols('original')).toContain('original'); clean();
  });

  it('does not call a recreated committed deletion removed when the current bytes match the DB', async () => {
    fs.unlinkSync(path.join(root, 'source.ts')); commit();
    write('source.ts', 'original');
    clean();
    write('source.ts', 'replacement');
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: ['source.ts'], removed: [] });
    await cg.sync(); expect(symbols('replacement')).toContain('replacement'); clean();
  });

  it('retains deleted untracked files as candidates after they were indexed', async () => {
    write('untracked.ts', 'temporary'); await cg.sync();
    fs.unlinkSync(path.join(root, 'untracked.ts'));
    expect(cg.getChangedFiles().removed).toEqual(['untracked.ts']);
    await cg.sync(); expect(symbols('temporary')).not.toContain('temporary'); clean();
  });

  it('never advances freshness after a failed full index', async () => {
    write('new.ts', 'newSymbol'); commit();
    const controller = new AbortController(); controller.abort();
    expect((await cg.indexAll({ signal: controller.signal })).success).toBe(false);
    expect(cg.getChangedFiles().added).toEqual(['new.ts']);
  });

  it('keeps a committed path pending when sync cannot read it', async () => {
    write('new.ts', 'newSymbol'); commit();
    let injected = 0;
    const failNewTs = (real: (...args: any[]) => unknown, file: any, ...args: any[]) => {
      if (String(file) === path.join(root, 'new.ts')) { injected++; throw new Error('Injected transient read error'); }
      return real(file, ...args);
    };
    injectReadFileSync(failNewTs);
    injectOpenSync(failNewTs);
    await cg.sync();
    expect(injected).toBeGreaterThan(0);
    expect(symbols('newSymbol')).not.toContain('newSymbol');
    reinstateIo();
    expect(cg.getChangedFiles().added).toEqual(['new.ts']);
    await cg.sync(); clean();
  });
});
