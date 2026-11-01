/**
 * Reads of paths that are not on disk, and the sparse checkout that makes them.
 *
 * `git ls-files` lists every tracked path, including the ones a sparse checkout
 * leaves out of the working tree. Each such path used to cost a walk up its
 * ancestors in `validatePathWithinRoot`, once in framework detection and once
 * in the batch reader, on the main thread. A clone with tens of thousands of
 * them spent minutes there, long enough for the liveness watchdog to kill it.
 *
 * Nothing here measures time. The walk is counted in `realpathSync` calls, and
 * the rest asserts what a sparse checkout should come to: the scan lists what is
 * there, and nothing outside the sparse set is read, failed, or called deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { scanDirectory } from '../src/extraction';
import { validatePathWithinRoot } from '../src/utils';

// A pass-through module object, so `realpathSync` can be counted.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

/** Every path `realpathSync` is asked about from here on. */
function recordRealpaths(): string[] {
  const real = fs.realpathSync;
  const asked: string[] = [];
  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...rest: []) => {
    asked.push(String(p));
    return real(p, ...rest);
  }) as typeof fs.realpathSync);
  Object.assign(fs.realpathSync, { native: real.native });
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validatePathWithinRoot on a missing path', () => {
  let root: string;
  let outside: string;
  const missing = 'server/src/main/java/org/Gone.java';
  const missingAbs = () => path.join(root, ...missing.split('/'));

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-missing-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-missing-outside-')));
    fs.mkdirSync(path.join(root, 'server'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET\n');
  });

  afterEach(() => {
    fs.rmSync(path.join(root, 'linked'), { force: true }); // the link itself, before the folder
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it.each([
    ['a read', { readOnly: true }],
    ['an indexing read', { allowSymlinkEscape: true }],
  ])('%s asks about the root and the path, and no ancestor', (_label, options) => {
    const asked = recordRealpaths();
    expect(validatePathWithinRoot(root, missing, options)).toBe(missingAbs());
    expect(asked).toEqual([root, missingAbs()]);
  });

  it('a write still walks up to the nearest existing ancestor', () => {
    const asked = recordRealpaths();
    expect(validatePathWithinRoot(root, missing)).toBe(missingAbs());
    expect(asked).toContain(path.join(root, 'server'));
    expect(asked).toContain(path.join(root, 'server', 'src', 'main'));
  });

  describe('below a link out of the root', () => {
    beforeEach(() => {
      // A junction needs no privileges on Windows, and a junction is a link here.
      fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    });

    it('a write is refused, or mkdir would follow the link out', () => {
      expect(validatePathWithinRoot(root, 'linked/not-yet/file.txt')).toBeNull();
    });

    it('a read of a missing path gets the path, since nothing is there to read', () => {
      expect(validatePathWithinRoot(root, 'linked/not-yet/file.txt', { readOnly: true }))
        .toBe(path.join(root, 'linked', 'not-yet', 'file.txt'));
    });

    it('a read of a file that is there is refused as before', () => {
      expect(validatePathWithinRoot(root, 'linked/secret.txt', { readOnly: true })).toBeNull();
    });
  });

  it('a read keeps the guards that do not depend on the path being there', () => {
    expect(validatePathWithinRoot(root, `../${path.basename(outside)}/secret.txt`, { readOnly: true })).toBeNull();
    expect(validatePathWithinRoot(path.join(root, 'no-such-root'), 'file.txt', { readOnly: true })).toBeNull();
    expect(validatePathWithinRoot(path.join(root, 'no-such-root'), 'file.txt', { allowSymlinkEscape: true })).toBeNull();
  });
});

describe('a repository with tracked files off the disk', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const git = (...args: string[]) =>
    cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (rel: string, body = `class ${path.basename(rel, path.extname(rel))} {}\n`) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const metadata = (key: string): string | null => (cg as any).queries.getMetadata(key);
  const indexedPaths = (): string[] => (cg as any).queries.getAllFilePaths().sort();
  const noChanges = { added: [], modified: [], removed: [] };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sparse-')));
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    write('kept/Here.java');
    write('kept/deep/There.java');
    write('away/one/two/Gone.java');
    write('away/one/two/AlsoGone.java');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A real sparse checkout; `away/` and everything under it leaves the disk. */
  const sparse = (...extra: string[]) => {
    git('sparse-checkout', 'set', ...extra, 'kept');
    expect(fs.existsSync(path.join(root, 'away'))).toBe(false);
    expect(git('ls-files', '-t')).toContain('S away/one/two/Gone.java'); // the premise: git lists them
  };
  const onDisk = ['kept/Here.java', 'kept/deep/There.java'];

  it('the scan lists what the checkout holds, not what it leaves out', () => {
    sparse();
    expect(scanDirectory(root).sort()).toEqual(onDisk);
  });

  it('the scan reads a sparse index the same way', () => {
    sparse('--sparse-index');
    expect(scanDirectory(root).sort()).toEqual(onDisk);
  });

  it('a full index has nothing to skip, and leaves nothing pending', async () => {
    sparse();
    cg = CodeGraph.initSync(root);
    const result = await cg.indexAll();
    expect(result.filesIndexed).toBe(onDisk.length);
    expect(result.filesSkipped).toBe(0);
    expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(metadata('index_state')).toBe('complete');
    expect(indexedPaths()).toEqual(onDisk);
    expect(cg.getChangedFiles()).toEqual(noChanges);
  });

  it('a sync does not call the left-out files failed, or remember them as dirty', async () => {
    sparse();
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    write('kept/Here.java', 'class Here { int edited; }\n');

    const result = await cg.sync();
    expect(result.filesModified).toBe(1);
    expect(result.failedFilePaths).toBeUndefined();
    expect(metadata('indexed_dirty_paths')).not.toContain('away/');
    expect(indexedPaths()).toEqual(onDisk);
    expect(cg.getChangedFiles()).toEqual(noChanges);
  });

  it('files follow the sparse set as it narrows and widens', async () => {
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const all = ['away/one/two/AlsoGone.java', 'away/one/two/Gone.java', ...onDisk];
    expect(indexedPaths()).toEqual(all);

    sparse();
    const narrowed = await cg.sync();
    expect(narrowed.filesRemoved).toBe(2);
    expect(narrowed.failedFilePaths).toBeUndefined();
    expect(indexedPaths()).toEqual(onDisk);

    git('sparse-checkout', 'disable');
    expect((await cg.sync()).filesAdded).toBe(2);
    expect(indexedPaths()).toEqual(all);
  });

  it('a file marked skip-worktree that is on disk stays in the index', async () => {
    // The other use of the bit: `update-index --skip-worktree` keeps local edits
    // to a tracked file away from git, and the file stays right there.
    git('update-index', '--skip-worktree', 'kept/Here.java');
    expect(git('ls-files', '-t')).toContain('S kept/Here.java');
    expect(scanDirectory(root)).toContain('kept/Here.java');

    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(indexedPaths()).toContain('kept/Here.java');
    write('kept/Here.java', 'class Here { int local; }\n');
    expect((await cg.sync()).filesModified).toBe(1);
    expect(indexedPaths()).toContain('kept/Here.java');
  });

  it('a deleted file git still lists costs no walk, in detection or in the reader', async () => {
    fs.rmSync(path.join(root, 'away'), { recursive: true });
    expect(git('ls-files')).toContain('away/one/two/Gone.java'); // the premise
    cg = CodeGraph.initSync(root);

    const asked = recordRealpaths();
    const result = await cg.indexAll();
    expect(indexedPaths()).toEqual(onDisk);
    expect(result.filesSkipped).toBe(2);
    // Spring detection reads every `.java` the scan lists, and the reader tries
    // them all, so both asked about the missing files themselves. Only the walk
    // would ask about the folders they were in.
    expect(asked).toContain(path.join(root, 'away', 'one', 'two', 'Gone.java'));
    expect(asked).not.toContain(path.join(root, 'away', 'one', 'two'));
    expect(asked).not.toContain(path.join(root, 'away'));
  });
});
