/**
 * Multi-repo workspaces (#514): a directory holding several independent git
 * repositories must index as a whole.
 *
 * Two enumeration paths are exercised:
 *  - git path: the workspace root is itself a git repo (a "super-repo") whose
 *    `.gitignore` hides the child repos to keep `git status` quiet. git never
 *    lists ignored dirs, so the embedded repos were invisible (0 files). They
 *    are now discovered via the ignored-directories listing and enumerated by
 *    their own `git ls-files`. (#193 covered the *untracked* embedded case.)
 *  - sync path: `git status` in the parent says nothing about embedded repos;
 *    change detection now recurses into them.
 *
 * The non-git-parent case (plain folder of repos) already worked via the
 * filesystem walk — locked in here so it stays that way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { scanDirectory, buildScopeIgnore, discoverEmbeddedRepoRoots } from '../src/extraction';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** git init + commit everything currently in `dir` as one repo. */
function makeRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty');
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('multi-repo workspaces (#514)', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-multirepo-'));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('indexes embedded repos hidden by the super-repo .gitignore', () => {
    write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() { return 1; }\n');
    write(path.join(ws, 'packages/proj-b/src/billing.ts'), 'export function charge() { return 2; }\n');
    makeRepo(path.join(ws, 'packages/proj-a'));
    makeRepo(path.join(ws, 'packages/proj-b'));
    write(path.join(ws, '.gitignore'), '/packages/\n');
    write(path.join(ws, 'tools.ts'), 'export function tool() { return 0; }\n');
    makeRepo(ws);

    const files = scanDirectory(ws);
    expect(files).toContain('packages/proj-a/src/auth.ts');
    expect(files).toContain('packages/proj-b/src/billing.ts');
    expect(files).toContain('tools.ts'); // the parent's own tracked code still indexes
  });

  it('keeps respecting the parent .gitignore for the parent own (non-repo) dirs', () => {
    write(path.join(ws, 'scratch/junk.ts'), 'export function junk() { return 9; }\n');
    write(path.join(ws, 'src/app.ts'), 'export function app() { return 1; }\n');
    write(path.join(ws, '.gitignore'), '/scratch/\n');
    makeRepo(ws);

    const files = scanDirectory(ws);
    expect(files).toContain('src/app.ts');
    // scratch/ is gitignored and contains NO embedded repo — stays excluded.
    expect(files.some((f) => f.startsWith('scratch/'))).toBe(false);
  });

  it('never descends into git repos inside node_modules (npm git-dependencies)', () => {
    // Embedded repo first (clean), node_modules dropped in afterwards —
    // matching reality, where node_modules is never committed.
    write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
    makeRepo(path.join(ws, 'packages/proj-a'));
    write(path.join(ws, 'packages/proj-a/node_modules/inner/src/evil2.ts'), 'export function evil2() {}\n');
    makeRepo(path.join(ws, 'packages/proj-a/node_modules/inner')); // npm git-dep: has commits
    // Workspace-level git-dep too.
    write(path.join(ws, 'node_modules/git-dep/src/evil.ts'), 'export function evil() {}\n');
    makeRepo(path.join(ws, 'node_modules/git-dep'));
    write(path.join(ws, '.gitignore'), '/packages/\nnode_modules\n');
    makeRepo(ws);

    const files = scanDirectory(ws);
    expect(files).toContain('packages/proj-a/src/auth.ts');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('still indexes UNTRACKED embedded repos (#193 regression)', () => {
    write(path.join(ws, 'vendor-src/lib/src/util.ts'), 'export function util() {}\n');
    makeRepo(path.join(ws, 'vendor-src/lib'));
    write(path.join(ws, 'main.ts'), 'export function main() {}\n');
    makeRepo(ws); // vendor-src/ is untracked (not ignored) — committed ws has only main.ts + nothing else
    // NOTE: makeRepo committed vendor-src too via add -A… recreate untracked state:
    git(ws, 'rm', '-r', '--cached', '-q', 'vendor-src');
    git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'untrack');

    const files = scanDirectory(ws);
    expect(files).toContain('vendor-src/lib/src/util.ts');
    expect(files).toContain('main.ts');
  });

  it('skips nested git worktrees instead of indexing them as duplicate embedded repos (#848)', () => {
    // Claude Code (and others) create worktrees under a gitignored path like
    // `.claude/worktrees/<name>/`. A worktree's `.git` is a FILE pointing into
    // the host repo's own `.git/worktrees/`, so it is the SAME repo already
    // indexed — sweeping it in as an embedded repo multiplies the whole graph.
    // A genuine embedded clone (a `.git` *directory*) must still be indexed.
    write(path.join(ws, 'src/app.ts'), 'export function app() { return 1; }\n');
    write(path.join(ws, '.gitignore'), '.claude/\nvendored/\n');
    makeRepo(ws);
    // A real linked worktree under the gitignored .claude/worktrees/.
    git(ws, 'worktree', 'add', '-q', '.claude/worktrees/feature', '-b', 'feature');
    // A genuine embedded clone, also gitignored — must STAY indexed (#514).
    write(path.join(ws, 'vendored/lib.ts'), 'export function vendoredFn() { return 9; }\n');
    makeRepo(path.join(ws, 'vendored'));

    const files = scanDirectory(ws);
    expect(files).toContain('src/app.ts');
    // The worktree is a duplicate working view — never indexed.
    expect(files.some((f) => f.includes('.claude/worktrees'))).toBe(false);
    // The genuine embedded clone is still indexed (#514/#622 preserved).
    expect(files).toContain('vendored/lib.ts');
  });

  it('non-git workspace: walks children and respects each child own .gitignore', () => {
    write(path.join(ws, 'proj-a/src/auth.ts'), 'export function login() {}\n');
    write(path.join(ws, 'proj-a/build/out.ts'), 'export function generated() {}\n');
    write(path.join(ws, 'proj-a/.gitignore'), 'build/\n');
    write(path.join(ws, 'proj-b/src/billing.ts'), 'export function charge() {}\n');
    makeRepo(path.join(ws, 'proj-a'));
    makeRepo(path.join(ws, 'proj-b'));
    // ws itself is NOT a git repo.

    const files = scanDirectory(ws);
    expect(files).toContain('proj-a/src/auth.ts');
    expect(files).toContain('proj-b/src/billing.ts');
    expect(files.some((f) => f.includes('build/'))).toBe(false);
  });

  it('does not search beyond the embedded-repo depth cap', () => {
    // Repo buried 5 levels under the ignored dir — past EMBEDDED_REPO_SEARCH_DEPTH (4).
    const deep = path.join(ws, 'pkgs/a/b/c/d/e');
    write(path.join(deep, 'src/deep.ts'), 'export function deep() {}\n');
    makeRepo(deep);
    write(path.join(ws, 'main.ts'), 'export function main() {}\n');
    write(path.join(ws, '.gitignore'), '/pkgs/\n');
    makeRepo(ws);

    const files = scanDirectory(ws);
    expect(files).toContain('main.ts');
    expect(files.some((f) => f.includes('deep.ts'))).toBe(false);
  });

  it('discovers embedded roots (ignored + untracked kinds); none for non-git roots', () => {
    write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
    makeRepo(path.join(ws, 'packages/proj-a'));
    write(path.join(ws, 'vendor-src/lib/util.ts'), 'export function util() {}\n');
    makeRepo(path.join(ws, 'vendor-src/lib'));
    write(path.join(ws, '.gitignore'), '/packages/\n'); // vendor-src stays untracked
    makeRepo(ws);
    git(ws, 'rm', '-r', '--cached', '-q', 'vendor-src');
    git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'untrack');

    const roots = discoverEmbeddedRepoRoots(ws);
    expect(roots).toContain('packages/proj-a/');
    expect(roots).toContain('vendor-src/lib/');

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nongit-'));
    try {
      expect(discoverEmbeddedRepoRoots(plain)).toEqual([]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('ScopeIgnore: embedded files use the child rules; the watcher can descend to them', () => {
    write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
    write(path.join(ws, 'packages/proj-a/.gitignore'), 'build/\n');
    makeRepo(path.join(ws, 'packages/proj-a'));
    write(path.join(ws, '.gitignore'), '/packages/\n');
    makeRepo(ws);

    const scope = buildScopeIgnore(ws);
    // Inside the embedded repo: the CHILD's rules decide.
    expect(scope.ignores('packages/proj-a/src/auth.ts')).toBe(false);
    expect(scope.ignores('packages/proj-a/build/out.ts')).toBe(true);
    // Under the ignored dir but NOT in any embedded repo: parent rules apply.
    expect(scope.ignores('packages/stray.ts')).toBe(true);
    // Directory form: ancestors of an embedded root are never pruned —
    // the Linux per-directory watcher must descend through `packages/`.
    expect(scope.ignores('packages/')).toBe(false);
    // Ordinary paths: unchanged semantics.
    expect(scope.ignores('node_modules/dep/index.ts')).toBe(true);
    expect(scope.ignores('src/app.ts')).toBe(false);
  });

  it('sync picks up a change inside a gitignored embedded repo', async () => {
    write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() { return 1; }\n');
    makeRepo(path.join(ws, 'packages/proj-a'));
    write(path.join(ws, '.gitignore'), '/packages/\n');
    makeRepo(ws);

    const cg = CodeGraph.initSync(ws, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await cg.indexAll();
      expect(cg.searchNodes('login', { limit: 5 }).length).toBeGreaterThan(0);

      // Change inside the embedded repo — invisible to the parent's `git status`.
      write(path.join(ws, 'packages/proj-a/src/auth.ts'),
        'export function login() { return 1; }\nexport function logout() { return 0; }\n');
      await cg.sync();

      expect(cg.searchNodes('logout', { limit: 5 }).length).toBeGreaterThan(0);
    } finally {
      cg.destroy();
    }
  });
});
