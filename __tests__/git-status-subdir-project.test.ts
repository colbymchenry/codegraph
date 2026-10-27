/**
 * Change detection for a project in a folder below its repository root (#1636).
 *
 * `git status --porcelain` prints paths from the repository root whatever
 * folder it runs in, and reports the whole repository. A project in `app/`
 * read `app/src/index.js` as its own `app/src/index.js`, found nothing at
 * `app/app/src/index.js`, and dropped it: `codegraph status` (and the MCP
 * freshness check) said the index was up to date while `codegraph sync`
 * re-indexed the very same files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getGitChangedFiles } from '../src/extraction';

// A pass-through execFileSync, so a test can read the exact git commands run.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const CLEAN = { added: [], modified: [], removed: [] };

function makeRepo(prefix: string): { repo: string; git: (...args: string[]) => string; write: (rel: string, body: string) => void } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) =>
    cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) as string;
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { repo, git, write };
}

/** The `git status` runs made since the last clear, as [cwd, args]. */
function gitStatusRuns(): Array<[string, string[]]> {
  return vi.mocked(cp.execFileSync).mock.calls
    .filter(([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === 'status')
    .map(([, args, opts]) => [String((opts as { cwd?: string } | undefined)?.cwd ?? ''), args as string[]]);
}

describe('a project in a folder below its repository root (#1636)', () => {
  let repo: string;
  let project: string;
  let git: (...args: string[]) => string;
  let write: (rel: string, body: string) => void;
  let cg: CodeGraph | undefined;
  const changes = () => cg!.getChangedFiles();

  beforeEach(async () => {
    ({ repo, git, write } = makeRepo('cg-subdir-project-'));
    project = path.join(repo, 'app');
    write('.gitignore', '.codegraph/\n');
    write('outside.js', 'function outside() {}\n');
    write('app/src/index.js', 'function hello() {}\n');
    write('app/src/other.js', 'function other() {}\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    cg = CodeGraph.initSync(project);
    await cg.indexAll();
    expect(changes()).toEqual(CLEAN);
  });

  afterEach(() => {
    vi.mocked(cp.execFileSync).mockClear();
    cg?.close();
    cg = undefined;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('sees an edited, an added and a deleted file, as sync does', async () => {
    write('app/src/index.js', 'function renamedHello() { return 2; }\n');
    write('app/src/added.js', 'function added() {}\n');
    fs.unlinkSync(path.join(project, 'src', 'other.js'));
    expect(getGitChangedFiles(project)).toEqual({ added: ['src/added.js'], modified: ['src/index.js'], deleted: ['src/other.js'] });
    expect(changes()).toEqual({ added: ['src/added.js'], modified: ['src/index.js'], removed: ['src/other.js'] });

    const synced = await cg!.sync();
    expect([synced.filesAdded, synced.filesModified, synced.filesRemoved]).toEqual([1, 1, 1]);
    expect(changes()).toEqual(CLEAN);
  });

  it('leaves out changes outside the project, and asks git about the project only', () => {
    vi.mocked(cp.execFileSync).mockClear();
    write('outside.js', 'function outside() { return 1; }\n');
    write('sibling/new.js', 'function sibling() {}\n');
    expect(changes()).toEqual(CLEAN);
    const runs = gitStatusRuns().filter(([cwd]) => cwd === project);
    expect(runs.length).toBeGreaterThan(0);
    for (const [, args] of runs) expect(args.slice(-2)).toEqual(['--', '.']);
  });

  it('sees an indexed edit that git restored, after a reopen too (#1878)', async () => {
    write('app/src/index.js', 'function dirtyHello() {}\n');
    await cg!.sync();
    git('checkout', '--', 'app/src/index.js');
    expect(git('status', '--porcelain')).toBe('');
    expect(changes().modified).toEqual(['src/index.js']);
    cg!.close();
    cg = CodeGraph.openSync(project);
    expect(changes().modified).toEqual(['src/index.js']);
    await cg.sync();
    expect(changes()).toEqual(CLEAN);
  });

  it("matches the project's own .gitignore against its paths", () => {
    // A tracked file under a folder the project's .gitignore anchors (`/generated/`):
    // git status still lists its edits, and the full index leaves it out. The
    // rule matches `generated/out.js`, never the repository's `app/generated/out.js`.
    write('app/generated/out.js', 'function generated() {}\n');
    git('add', '-A');
    git('commit', '-qm', 'generated');
    write('app/.gitignore', '/generated/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore generated');
    write('app/generated/out.js', 'function generated() { return 1; }\n');
    write('app/src/kept.js', 'function kept() {}\n');
    expect(getGitChangedFiles(project)).toEqual({ added: ['src/kept.js'], modified: [], deleted: [] });
    expect(changes()).toEqual({ added: ['src/kept.js'], modified: [], removed: [] });
  });

  it('reads an embedded repository inside the project', () => {
    const embedded = path.join(project, 'vendored');
    fs.mkdirSync(embedded);
    cp.execFileSync('git', ['init', '-q'], { cwd: embedded, stdio: 'pipe' });
    write('app/vendored/lib.js', 'function lib() {}\n');
    expect(changes().added).toEqual(['vendored/lib.js']);
  });
});

describe('a project in a folder its repository ignores (#1636)', () => {
  it('falls back to the full scan, which sees the edits', async () => {
    const { repo, git, write } = makeRepo('cg-ignored-project-');
    const project = path.join(repo, 'app');
    write('.gitignore', 'app/\n');
    write('outside.js', 'function outside() {}\n');
    write('app/src/index.js', 'function hello() {}\n');
    git('add', '-A');
    git('commit', '-qm', 'init; app/ is ignored');
    const cg = CodeGraph.initSync(project);
    try {
      await cg.indexAll();
      expect(cg.getChangedFiles()).toEqual(CLEAN);
      write('app/src/index.js', 'function renamedHello() { return 2; }\n');
      write('app/src/added.js', 'function added() {}\n');
      // git can say nothing about an ignored folder, so it is not asked.
      expect(getGitChangedFiles(project)).toBeNull();
      expect(cg.getChangedFiles()).toEqual({ added: ['src/added.js'], modified: ['src/index.js'], removed: [] });
    } finally {
      cg.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('a project at its repository root', () => {
  it('runs exactly the git status it always ran', async () => {
    const { repo, git, write } = makeRepo('cg-root-project-');
    write('.gitignore', '.codegraph/\n');
    write('src/index.js', 'function hello() {}\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    const asked = () => vi.mocked(cp.execFileSync).mock.calls.map(([, args]) => (args as string[]).join(' '));
    // From the first open on, so an answer kept from the index run counts too.
    vi.mocked(cp.execFileSync).mockClear();
    const cg = CodeGraph.initSync(repo);
    try {
      await cg.indexAll();
      write('src/index.js', 'function hello() { return 1; }\n');
      write('src/added.js', 'function added() {}\n');
      const beforeStatus = asked().length;
      expect(cg.getChangedFiles()).toEqual({ added: ['src/added.js'], modified: ['src/index.js'], removed: [] });
      const runs = gitStatusRuns();
      expect(runs.length).toBeGreaterThan(0);
      for (const [, args] of runs) expect(args).toEqual(['status', '--porcelain', '--no-renames', '-z', '-uall']);
      expect(asked().filter((a) => a.includes('--show-prefix'))).toEqual([]);
      expect(asked().slice(beforeStatus).filter((a) => a.startsWith('check-ignore'))).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
