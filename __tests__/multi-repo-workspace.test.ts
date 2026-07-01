/**
 * Multi-repo workspaces (#514) — and the `.gitignore`-respect default (#970, #976).
 *
 * A directory holding several independent git repositories can be indexed as a
 * whole, but ONLY when the project opts the gitignored directories in. The
 * default is the universal one: `.gitignore` excludes. Walking into a gitignored
 * directory to index embedded repos there is OPT-IN via `codegraph.json`
 * `includeIgnored` (#622, #699) — without it a gitignored `node_modules`-style
 * reference/data dir full of nested clones is left untouched, instead of blowing
 * the graph up or stalling the scan (#970, #976).
 *
 * Two enumeration paths are exercised under opt-in:
 *  - git path: the workspace root is itself a git repo (a "super-repo") whose
 *    `.gitignore` hides the child repos. They are discovered via the ignored-
 *    directories listing and enumerated by their own `git ls-files`. (#193
 *    covered the *untracked* embedded case, which stays on by default.)
 *  - sync path: `git status` in the parent says nothing about embedded repos;
 *    change detection recurses into the opted-in ones.
 *
 * The non-git-parent case (plain folder of repos) works via the filesystem walk
 * regardless — locked in here so it stays that way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { scanDirectory, buildScopeIgnore, discoverEmbeddedRepoRoots } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';

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

describe('multi-repo workspaces (#514) + .gitignore-respect default (#970, #976)', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-multirepo-'));
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** Drop a `codegraph.json` at the workspace root. */
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(ws, 'codegraph.json'),
      typeof obj === 'string' ? obj : JSON.stringify(obj));

  describe('default: .gitignore is respected (#970, #976)', () => {
    it('does NOT index embedded repos inside a gitignored dir without opt-in', () => {
      // The exact #976 layout: nested clones under a directory the user
      // explicitly gitignored. They must stay out of the index — no graph blowup.
      write(path.join(ws, '.repos/lib-a/src/a.ts'), 'export function fromLibA() { return 1; }\n');
      write(path.join(ws, '.repos/lib-b/src/b.ts'), 'export function fromLibB() { return 2; }\n');
      makeRepo(path.join(ws, '.repos/lib-a'));
      makeRepo(path.join(ws, '.repos/lib-b'));
      write(path.join(ws, '.gitignore'), '/.repos/\n');
      write(path.join(ws, 'app.ts'), 'export function app() { return 0; }\n');
      makeRepo(ws);

      const files = scanDirectory(ws);
      expect(files).toContain('app.ts'); // the project's own code still indexes
      expect(files.some((f) => f.startsWith('.repos/'))).toBe(false);
    });

    it('does NOT discover gitignored embedded roots without opt-in', () => {
      write(path.join(ws, 'resource/ref/src/x.ts'), 'export const x = 1;\n');
      makeRepo(path.join(ws, 'resource/ref'));
      write(path.join(ws, '.gitignore'), '/resource/\n');
      makeRepo(ws);

      // The #970 perf fix: a gitignored dir of reference repos is never walked.
      expect(discoverEmbeddedRepoRoots(ws)).toEqual([]);
    });

    it('ScopeIgnore: a gitignored dir is fully pruned without opt-in', () => {
      write(path.join(ws, 'resource/ref/src/x.ts'), 'export const x = 1;\n');
      makeRepo(path.join(ws, 'resource/ref'));
      write(path.join(ws, '.gitignore'), '/resource/\n');
      makeRepo(ws);

      const scope = buildScopeIgnore(ws);
      // Both the dir and its contents are ignored — the watcher won't descend.
      expect(scope.ignores('resource/')).toBe(true);
      expect(scope.ignores('resource/ref/src/x.ts')).toBe(true);
    });
  });

  describe('opt-in: codegraph.json includeIgnored re-includes a gitignored dir (#622, #699)', () => {
    it('indexes embedded repos hidden by the super-repo .gitignore', () => {
      write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() { return 1; }\n');
      write(path.join(ws, 'packages/proj-b/src/billing.ts'), 'export function charge() { return 2; }\n');
      makeRepo(path.join(ws, 'packages/proj-a'));
      makeRepo(path.join(ws, 'packages/proj-b'));
      write(path.join(ws, '.gitignore'), '/packages/\n');
      write(path.join(ws, 'tools.ts'), 'export function tool() { return 0; }\n');
      writeConfig({ includeIgnored: ['packages/'] });
      makeRepo(ws);

      const files = scanDirectory(ws);
      expect(files).toContain('packages/proj-a/src/auth.ts');
      expect(files).toContain('packages/proj-b/src/billing.ts');
      expect(files).toContain('tools.ts'); // the parent's own tracked code still indexes
    });

    it('only re-includes the opted-in dir, not every gitignored dir', () => {
      // `packages/` is opted in; `scratch/` (also holding a repo) is NOT.
      write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
      makeRepo(path.join(ws, 'packages/proj-a'));
      write(path.join(ws, 'scratch/throwaway/src/junk.ts'), 'export function junk() {}\n');
      makeRepo(path.join(ws, 'scratch/throwaway'));
      write(path.join(ws, '.gitignore'), '/packages/\n/scratch/\n');
      writeConfig({ includeIgnored: ['packages/'] });
      makeRepo(ws);

      const files = scanDirectory(ws);
      expect(files).toContain('packages/proj-a/src/auth.ts');
      expect(files.some((f) => f.startsWith('scratch/'))).toBe(false);
    });

    it('discovers the opted-in ignored root alongside untracked roots', () => {
      write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
      makeRepo(path.join(ws, 'packages/proj-a'));
      write(path.join(ws, 'vendor-src/lib/util.ts'), 'export function util() {}\n');
      makeRepo(path.join(ws, 'vendor-src/lib'));
      write(path.join(ws, '.gitignore'), '/packages/\n'); // vendor-src stays untracked
      writeConfig({ includeIgnored: ['packages/'] });
      makeRepo(ws);
      git(ws, 'rm', '-r', '--cached', '-q', 'vendor-src');
      git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'untrack');

      const roots = discoverEmbeddedRepoRoots(ws);
      expect(roots).toContain('packages/proj-a/'); // opted-in ignored kind
      expect(roots).toContain('vendor-src/lib/');   // untracked kind (always on)
    });

    it('ScopeIgnore: opted-in embedded files use the child rules; the watcher can descend', () => {
      write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() {}\n');
      write(path.join(ws, 'packages/proj-a/.gitignore'), 'build/\n');
      makeRepo(path.join(ws, 'packages/proj-a'));
      write(path.join(ws, '.gitignore'), '/packages/\n');
      writeConfig({ includeIgnored: ['packages/'] });
      makeRepo(ws);

      const scope = buildScopeIgnore(ws);
      // Inside the opted-in embedded repo: the CHILD's rules decide.
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

    it('sync picks up a change inside an opted-in gitignored embedded repo', async () => {
      write(path.join(ws, 'packages/proj-a/src/auth.ts'), 'export function login() { return 1; }\n');
      makeRepo(path.join(ws, 'packages/proj-a'));
      write(path.join(ws, '.gitignore'), '/packages/\n');
      writeConfig({ includeIgnored: ['packages/'] });
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

  describe('discovery/classifier machinery (exercised under opt-in)', () => {
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
      writeConfig({ includeIgnored: ['packages/'] });
      makeRepo(ws);

      const files = scanDirectory(ws);
      expect(files).toContain('packages/proj-a/src/auth.ts');
      // node_modules is a built-in default exclude — never re-included, even though
      // `packages/` is opted in and node_modules is gitignored.
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    });

    it('still indexes UNTRACKED embedded repos by default (#193 regression)', () => {
      write(path.join(ws, 'vendor-src/lib/src/util.ts'), 'export function util() {}\n');
      makeRepo(path.join(ws, 'vendor-src/lib'));
      write(path.join(ws, 'main.ts'), 'export function main() {}\n');
      makeRepo(ws); // vendor-src/ is untracked (not ignored) — committed ws has only main.ts + nothing else
      // NOTE: makeRepo committed vendor-src too via add -A… recreate untracked state:
      git(ws, 'rm', '-r', '--cached', '-q', 'vendor-src');
      git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'untrack');

      // No codegraph.json: the untracked path is unaffected by the opt-in gate.
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
      // Both dirs are opted in so the classifier (not the gitignore gate) is what
      // decides: the worktree is skipped, the genuine clone is kept.
      write(path.join(ws, 'src/app.ts'), 'export function app() { return 1; }\n');
      write(path.join(ws, '.gitignore'), '.claude/\nvendored/\n');
      writeConfig({ includeIgnored: ['.claude/', 'vendored/'] });
      makeRepo(ws);
      // A real linked worktree under the gitignored .claude/worktrees/.
      git(ws, 'worktree', 'add', '-q', '.claude/worktrees/feature', '-b', 'feature');
      // A genuine embedded clone, also gitignored — must STAY indexed under opt-in.
      write(path.join(ws, 'vendored/lib.ts'), 'export function vendoredFn() { return 9; }\n');
      makeRepo(path.join(ws, 'vendored'));

      const files = scanDirectory(ws);
      expect(files).toContain('src/app.ts');
      // The worktree is a duplicate working view — never indexed (#848).
      expect(files.some((f) => f.includes('.claude/worktrees'))).toBe(false);
      // The genuine embedded clone is still indexed under opt-in (#514/#622).
      expect(files).toContain('vendored/lib.ts');
    });

    it('skips a submodule worktree instead of indexing it as a duplicate (#945)', () => {
      // A worktree OF A SUBMODULE points its `.git` into
      // `.git/modules/<module>/worktrees/<name>` — not the top-level repo's
      // `.git/worktrees/`. The detector used to miss that extra `modules/<name>`
      // segment, so the worktree fell through to "embedded" and every symbol it
      // shared with the real submodule checkout got indexed twice. The submodule's
      // own checkout (`.git/modules/<module>`, no `worktrees/`) is distinct code
      // and must stay indexed. The worktree dir is opted in so the classifier is
      // what skips it (not the gitignore gate).
      const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-945-up-'));
      try {
        // The repo that becomes the submodule's origin.
        write(path.join(upstream, 'lib.ts'), 'export function libFn() { return 1; }\n');
        makeRepo(upstream);

        write(path.join(ws, 'src/app.ts'), 'export function app() { return 1; }\n');
        write(path.join(ws, '.gitignore'), '.worktrees/\n');
        writeConfig({ includeIgnored: ['.worktrees/'] });
        git(ws, 'init', '-q');
        // protocol.file.allow=always: modern git refuses a local-path submodule otherwise.
        git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'common');
        git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add submodule');

        // A worktree of the submodule, under the gitignored .worktrees/ — its `.git`
        // points into `.git/modules/common/worktrees/<name>`.
        git(path.join(ws, 'common'), 'worktree', 'add', '-q', '../.worktrees/common-feature', '-b', 'feature');

        const files = scanDirectory(ws);
        expect(files).toContain('src/app.ts');
        // The real submodule checkout is distinct code — still indexed (#514).
        expect(files).toContain('common/lib.ts');
        // The submodule worktree is a duplicate working view — never indexed (#945).
        expect(files.some((f) => f.includes('.worktrees'))).toBe(false);
      } finally {
        fs.rmSync(upstream, { recursive: true, force: true });
      }
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

    it('does not search beyond the embedded-repo depth cap (opted-in dir)', () => {
      // Repo buried 5 levels under the ignored dir — past EMBEDDED_REPO_SEARCH_DEPTH (4).
      const deep = path.join(ws, 'pkgs/a/b/c/d/e');
      write(path.join(deep, 'src/deep.ts'), 'export function deep() {}\n');
      makeRepo(deep);
      write(path.join(ws, 'main.ts'), 'export function main() {}\n');
      write(path.join(ws, '.gitignore'), '/pkgs/\n');
      writeConfig({ includeIgnored: ['pkgs/'] });
      makeRepo(ws);

      const files = scanDirectory(ws);
      expect(files).toContain('main.ts');
      expect(files.some((f) => f.includes('deep.ts'))).toBe(false);
    });

    it('buildScopeIgnore: indexed root is itself a gitignored subdir of an enclosing repo (#936)', () => {
      // `child/` is NOT its own repo, so `git` resolves the ENCLOSING repo from
      // inside it — and `git ls-files --directory`, whose cwd is then a wholly
      // ignored directory, emits the literal `./` ("this entire directory").
      // That sentinel used to reach the `ignore` matcher and throw
      // ("path should be a `path.relative()`d string, but got "./""), aborting
      // buildScopeIgnore → the MCP daemon's watcher never started and auto-sync
      // silently stalled until a manual `codegraph sync`.
      write(path.join(ws, 'child/src/a.ts'), 'export const x = 1;\n');
      write(path.join(ws, '.gitignore'), '/child/\n');
      makeRepo(ws);

      const child = path.join(ws, 'child');
      // The crux: building scope for the ignored subdir must not throw.
      const scope = buildScopeIgnore(child);
      // The subdir's own source is watchable/indexable, not ignored.
      expect(scope.ignores('src/a.ts')).toBe(false);
      // And the `./` self entry must not be mistaken for a nested embedded repo.
      expect(discoverEmbeddedRepoRoots(child)).toEqual([]);
    });
  });
});
