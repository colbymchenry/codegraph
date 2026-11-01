/**
 * `status` after the sparse checkout changes.
 *
 * Changing what a checkout holds changes nothing git reports: the files it
 * brings in or takes away are skip-worktree, or were, so `git status` stays
 * clean and the commit stays where it is. Only a stamp of the sparse state,
 * kept beside the indexed commit, can tell. A repo that isn't sparse must not
 * pay for that with a git process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// A pass-through execFileSync, so a test can read the exact git commands run.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const CLEAN = { added: [], modified: [], removed: [] };
const KEPT = ['kept/Here.ts', 'kept/deep/There.ts'];
const AWAY = ['away/Gone.ts', 'away/deep/AlsoGone.ts'];
const STAMP_KEY = 'indexed_sparse_checkout';

describe('status when the sparse checkout changes', () => {
  /** Every folder a test made, to remove afterwards. */
  let made: string[];
  /** Where git and CodeGraph run: a repo, a linked worktree, or a folder below a repo's root. */
  let project: string;
  let cg: CodeGraph | undefined;

  const git = (...args: string[]) =>
    cp.execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) as string;
  const write = (rel: string, body = `export class ${path.basename(rel, '.ts')} {}\n`) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), body);
  };
  const tempDir = (name: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
    made.push(dir);
    return dir;
  };
  const index = async () => {
    cg = CodeGraph.initSync(project);
    await cg.indexAll();
  };
  const metadata = (key: string): string | null => (cg as any).queries.getMetadata(key);
  const indexedPaths = (): string[] => (cg as any).queries.getAllFilePaths().sort();
  const changes = () => {
    const found = cg!.getChangedFiles();
    return { added: [...found.added].sort(), modified: [...found.modified].sort(), removed: [...found.removed].sort() };
  };
  /** The premise of every case here: as far as git can tell, nothing happened. */
  const gitSeesNothing = () => expect(git('status', '--porcelain')).toBe('');
  /** The git commands run since the last clear, each as one string. */
  const gitRuns = () => vi.mocked(cp.execFileSync).mock.calls
    .filter(([cmd]) => cmd === 'git')
    .map(([, args]) => (args as string[]).join(' '));

  beforeEach(() => {
    made = [];
    project = tempDir('cg-status-sparse-');
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('.gitignore', '.codegraph/\n');
    for (const rel of [...KEPT, ...AWAY]) write(rel);
    git('add', '-A');
    git('commit', '-qm', 'fixture');
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe.each([
    ['cone mode', { keep: ['--cone', 'kept'], both: ['--cone', 'kept', 'away'], widen: 'away' }],
    ['a sparse index', { keep: ['--cone', '--sparse-index', 'kept'], both: ['--cone', '--sparse-index', 'kept', 'away'], widen: 'away' }],
    ['hand-written patterns', { keep: ['--no-cone', '/*', '!/*/', '/kept/'], both: ['--no-cone', '/*', '!/*/', '/kept/', '/away/'], widen: '/away/' }],
  ])('with %s', (_name, mode) => {
    it('a widened checkout reads as added right after an index', async () => {
      git('sparse-checkout', 'set', ...mode.keep);
      await index();
      expect(changes()).toEqual(CLEAN);

      git('sparse-checkout', 'add', mode.widen);
      gitSeesNothing();
      expect(changes()).toEqual({ ...CLEAN, added: AWAY });
    });

    it('a widened checkout reads as added after a sync, too', async () => {
      git('sparse-checkout', 'set', ...mode.keep);
      await index();
      await cg!.sync();

      git('sparse-checkout', 'add', mode.widen);
      gitSeesNothing();
      expect(changes()).toEqual({ ...CLEAN, added: AWAY });
    });

    it('a narrowed checkout reads as removed', async () => {
      git('sparse-checkout', 'set', ...mode.both);
      await index();
      expect(indexedPaths()).toEqual([...AWAY, ...KEPT].sort());

      git('sparse-checkout', 'set', ...mode.keep);
      gitSeesNothing();
      expect(changes()).toEqual({ ...CLEAN, removed: AWAY });
    });

    it('a sync that has picked the change up leaves status up to date', async () => {
      git('sparse-checkout', 'set', ...mode.keep);
      await index();

      git('sparse-checkout', 'add', mode.widen);
      expect((await cg!.sync()).filesAdded).toBe(AWAY.length);
      expect(changes()).toEqual(CLEAN);

      git('sparse-checkout', 'set', ...mode.keep);
      expect((await cg!.sync()).filesRemoved).toBe(AWAY.length);
      expect(changes()).toEqual(CLEAN);
    });
  });

  it('the first narrowing of a full checkout reads as removed', async () => {
    await index();
    git('sparse-checkout', 'set', 'kept');
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, removed: AWAY });
  });

  it('turning the sparse checkout off reads as added, though the patterns stay as they were', async () => {
    git('sparse-checkout', 'set', 'kept');
    await index();
    const patterns = path.join(project, '.git', 'info', 'sparse-checkout');
    const before = fs.readFileSync(patterns, 'utf8');

    git('sparse-checkout', 'disable');
    expect(fs.readFileSync(patterns, 'utf8')).toBe(before); // the premise: git left the file alone
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, added: AWAY });

    await cg!.sync();
    expect(changes()).toEqual(CLEAN);

    git('sparse-checkout', 'set', 'kept');
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, removed: AWAY });
  });

  it('a change that moves no source file reports nothing', async () => {
    write('notes/readme.md', '# notes\n');
    git('add', '-A');
    git('commit', '-qm', 'notes');
    git('sparse-checkout', 'set', 'kept');
    await index();
    const stamp = metadata(STAMP_KEY);

    git('sparse-checkout', 'add', 'notes');
    expect(fs.existsSync(path.join(project, 'notes', 'readme.md'))).toBe(true);
    expect(changes()).toEqual(CLEAN);

    expect((await cg!.sync()).filesAdded).toBe(0);
    expect(metadata(STAMP_KEY)).not.toBe(stamp); // a sync with nothing to do still takes the new stamp
  });

  it('a real edit shows beside what the change brought in', async () => {
    git('sparse-checkout', 'set', 'kept');
    await index();
    git('sparse-checkout', 'add', 'away');
    write('kept/Here.ts', 'export class Here { edited = 1; }\n');
    expect(changes()).toEqual({ added: AWAY, modified: ['kept/Here.ts'], removed: [] });
  });

  it('works in a linked worktree, where .git is a file', async () => {
    const main = project;
    project = path.join(tempDir('cg-status-sparse-wt-'), 'wt');
    cp.execFileSync('git', ['worktree', 'add', '-q', project], { cwd: main, stdio: 'pipe' });
    expect(fs.statSync(path.join(project, '.git')).isFile()).toBe(true);

    git('sparse-checkout', 'set', 'kept');
    await index();
    expect(indexedPaths()).toEqual(KEPT);

    git('sparse-checkout', 'add', 'away');
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, added: AWAY });
    await cg!.sync();
    expect(changes()).toEqual(CLEAN);

    git('sparse-checkout', 'set', 'kept');
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, removed: AWAY });
    await cg!.sync();
    expect(changes()).toEqual(CLEAN);

    git('sparse-checkout', 'disable');
    gitSeesNothing();
    expect(changes()).toEqual({ ...CLEAN, added: AWAY });

    cg!.close();
    cg = undefined;
    cp.execFileSync('git', ['worktree', 'remove', '--force', project], { cwd: main, stdio: 'pipe' });
  });

  it('works for a project in a folder below its repository root', async () => {
    write('app/kept/Here.ts');
    write('app/away/Gone.ts');
    git('add', '-A');
    git('commit', '-qm', 'an app below the root');
    git('sparse-checkout', 'set', 'app/kept');
    const root = project;
    project = path.join(root, 'app');

    await index();
    expect(indexedPaths()).toEqual(['kept/Here.ts']);
    cp.execFileSync('git', ['sparse-checkout', 'add', 'app/away'], { cwd: root, stdio: 'pipe' });
    expect(changes()).toEqual({ ...CLEAN, added: ['away/Gone.ts'] });
  });

  it('an index from before the stamp reports nothing, until a sync starts one', async () => {
    git('sparse-checkout', 'set', 'kept');
    await index();
    (cg as any).queries.db.prepare('DELETE FROM project_metadata WHERE key = ?').run(STAMP_KEY);
    expect(metadata(STAMP_KEY)).toBeNull();

    git('sparse-checkout', 'add', 'away');
    expect(changes()).toEqual(CLEAN);

    await cg!.sync();
    expect(metadata(STAMP_KEY)).not.toBeNull();
    git('sparse-checkout', 'set', 'kept');
    expect(changes()).toEqual({ ...CLEAN, removed: AWAY });
  });

  it('a sync scoped to some paths leaves the stamp to a full one', async () => {
    git('sparse-checkout', 'set', 'kept');
    await index();
    const stamp = metadata(STAMP_KEY);

    git('sparse-checkout', 'add', 'away');
    await cg!.sync({ paths: [AWAY[0]!] });
    expect(metadata(STAMP_KEY)).toBe(stamp);
    expect(changes()).toEqual({ ...CLEAN, added: [AWAY[1]!] }); // only what is still missing

    await cg!.sync();
    expect(metadata(STAMP_KEY)).not.toBe(stamp);
    expect(changes()).toEqual(CLEAN);
  });

  describe('what it costs', () => {
    /** One `status`, after the first has built the scope matcher, which lists once per process. */
    const statusRuns = () => {
      cg!.getChangedFiles();
      vi.mocked(cp.execFileSync).mockClear();
      expect(cg!.getChangedFiles()).toEqual(CLEAN);
      return gitRuns();
    };
    /** The same with no stamp, where the check stops before it looks at anything. */
    const statusRunsWithoutTheStamp = () => {
      (cg as any).queries.db.prepare('DELETE FROM project_metadata WHERE key = ?').run(STAMP_KEY);
      return statusRuns();
    };
    /** The full scan's untracked listing. Embedded-repo discovery lists with `--directory`. */
    const scans = () => gitRuns().filter((run) => run === 'ls-files -z -o --exclude-standard');

    it('a repo that is not sparse runs no git command for it', async () => {
      await index();
      expect(metadata(STAMP_KEY)).toBe('');
      const stamped = statusRuns();
      expect(stamped).toContain('rev-parse HEAD'); // the premise: the spy sees what status runs
      expect(statusRunsWithoutTheStamp()).toEqual(stamped);
    });

    it('a sparse repo whose checkout has not moved runs none either', async () => {
      git('sparse-checkout', 'set', 'kept');
      await index();
      expect(metadata(STAMP_KEY)).toMatch(/^[0-9a-f]{64}$/);
      const stamped = statusRuns();
      expect(statusRunsWithoutTheStamp()).toEqual(stamped);
    });

    it('only a checkout that moved takes a scan', async () => {
      git('sparse-checkout', 'set', 'kept');
      await index();
      statusRuns();
      expect(scans()).toEqual([]);

      git('sparse-checkout', 'add', 'away');
      vi.mocked(cp.execFileSync).mockClear();
      expect(cg!.getChangedFiles().added).toHaveLength(AWAY.length);
      expect(scans()).toHaveLength(1);
    });
  });
});
