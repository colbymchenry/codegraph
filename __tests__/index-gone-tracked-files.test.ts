/**
 * A full index skips a file the scan lists but the disk no longer has (#2904).
 *
 * `git ls-files` keeps listing a tracked file deleted from the working tree
 * until the deletion is staged, so the scan hands the reader a path with
 * nothing behind it. That is not a file that "could not be read": the run
 * skips it, still accounts for it (an unaccounted file reads as a PARTIAL
 * index), and reports only listed files that are there but cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { IndexResult } from '../src/extraction';

// A pass-through `stat`, so one test can make a present file unreadable on
// every platform (chmod cannot do that on Windows).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

describe('full index of files git lists but the disk lacks (#2904)', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const git = (...args: string[]) =>
    cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (rel: string, name = path.basename(rel, '.py')) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `def ${name}():\n    return 1\n`);
  };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); };
  const readErrors = (r: IndexResult) => r.errors.filter((e) => e.code === 'read_error').map((e) => e.filePath);
  const metadata = (key: string): string | null => (cg as any).queries.getMetadata(key);
  const indexedPaths = (): string[] => (cg as any).queries.getAllFilePaths().sort();

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gone-tracked-')));
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A clean run over exactly `indexed`: nothing errored, unread or unaccounted. */
  const expectCleanRun = (result: IndexResult, indexed: string[]) => {
    expect(readErrors(result)).toEqual([]);
    expect(result.filesErrored).toBe(0);
    expect(result.filesIndexed).toBe(indexed.length);
    expect(result.errors.filter((e) => e.code === 'index_partial')).toEqual([]);
    expect(metadata('index_state')).toBe('complete');
    expect(indexedPaths()).toEqual(indexed);
  };

  it.each(['committed', 'staged'] as const)('skips a %s file deleted with the deletion unstaged', async (state) => {
    write('keep.py');
    write('gone.py');
    if (state === 'committed') commit(); else git('add', '-A');
    fs.unlinkSync(path.join(root, 'gone.py'));
    expect(git('ls-files')).toContain('gone.py'); // the premise: git still lists it

    cg = CodeGraph.initSync(root);
    expectCleanRun(await cg.indexAll(), ['keep.py']);
    // A clean run records the commit it indexed, so `status` keeps its git
    // fast path instead of falling back to a full scan.
    if (state === 'committed') expect(metadata('indexed_at_commit')).toBe(git('rev-parse', 'HEAD').trim());
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
  });

  it('skips a tracked file whose folder is now a file', async () => {
    write('keep.py');
    write('previous/gone.py');
    commit();
    fs.rmSync(path.join(root, 'previous'), { recursive: true });
    fs.writeFileSync(path.join(root, 'previous'), 'a file where the folder was\n');
    expect(git('ls-files')).toContain('previous/gone.py');

    cg = CodeGraph.initSync(root);
    expectCleanRun(await cg.indexAll(), ['keep.py']);
  });

  it('skips a symlink that points at nothing, as the directory walk does', async (ctx) => {
    write('keep.py');
    // File symlinks need Developer Mode or elevation on Windows.
    try { fs.symlinkSync('missing-target.py', path.join(root, 'broken.py')); } catch { ctx.skip(); }
    commit();

    cg = CodeGraph.initSync(root);
    expectCleanRun(await cg.indexAll(), ['keep.py']);
  });

  it('still reports a listed file that is there but cannot be read', async () => {
    write('keep.py');
    write('locked.py');
    write('gone.py');
    commit();
    fs.unlinkSync(path.join(root, 'gone.py'));
    const stat = vi.mocked(fsp.stat);
    const realStat = stat.getMockImplementation()!;
    stat.mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('locked.py')) {
        return Promise.reject(Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), { code: 'EACCES' }));
      }
      return (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
    }) as typeof fsp.stat);
    try {
      cg = CodeGraph.initSync(root);
      const result = await cg.indexAll();
      expect(readErrors(result)).toEqual(['locked.py']);
      expect(result.filesErrored).toBe(1);
      expect(result.filesIndexed).toBe(1);

      // The single-file path draws the same line.
      const files = await cg.indexFiles(['gone.py', 'locked.py']);
      expect(readErrors(files)).toEqual(['locked.py']);
      expect(files.filesErrored).toBe(1);
      expect(files.filesSkipped).toBe(1);
    } finally {
      stat.mockImplementation(realStat);
    }
  });
});
