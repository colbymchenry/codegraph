/**
 * Git worktree index-mismatch detection (issue #155).
 *
 * A CodeGraph index is resolved by walking up to the nearest `.codegraph/`.
 * When a worktree is nested inside the main checkout, that walk reaches the
 * MAIN checkout's index and a query silently returns the main branch's code
 * instead of the worktree's. `detectWorktreeIndexMismatch` spots exactly this
 * case so callers can warn.
 *
 * These tests drive real `git` against real temp worktrees — no mocking — so
 * they exercise the same `git rev-parse --show-toplevel` behavior production
 * relies on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  gitWorktreeRoot,
  gitCommonDir,
} from '../src/sync/worktree';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** realpath so macOS /var → /private/var symlinking doesn't break equality. */
function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

describe('detectWorktreeIndexMismatch (issue #155)', () => {
  let mainRepo: string;   // main checkout — owns the .codegraph index
  let worktree: string;   // a linked worktree nested inside the main checkout
  let nonGit: string;     // a directory outside any git repo

  beforeEach(() => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-main-'));
    nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-plain-'));

    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# main\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    // Nest the worktree under the main checkout, mirroring tools that place
    // worktrees in (gitignored) subpaths like `.claude/worktrees/<name>/`.
    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  });

  afterEach(() => {
    try { git(mainRepo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(nonGit, { recursive: true, force: true });
  });

  it('flags a worktree borrowing the main checkout index', () => {
    const m = detectWorktreeIndexMismatch(worktree, mainRepo);
    expect(m).not.toBeNull();
    expect(m!.worktreeRoot).toBe(real(worktree));
    expect(m!.indexRoot).toBe(real(mainRepo));
  });

  it('returns null when the index lives in the same working tree', () => {
    expect(detectWorktreeIndexMismatch(mainRepo, mainRepo)).toBeNull();
    expect(detectWorktreeIndexMismatch(worktree, worktree)).toBeNull();
  });

  it('returns null for a subdirectory of the same working tree', () => {
    const sub = path.join(mainRepo, 'src');
    fs.mkdirSync(sub);
    expect(detectWorktreeIndexMismatch(sub, mainRepo)).toBeNull();
  });

  it('returns null when startPath is not in a git repo', () => {
    expect(detectWorktreeIndexMismatch(nonGit, mainRepo)).toBeNull();
  });

  it('returns null when the index root is a plain (non-worktree) directory', () => {
    // startPath is a real worktree, but the index sits in an unrelated non-git
    // dir — that's "index in an ancestor", not "borrowed another worktree".
    expect(detectWorktreeIndexMismatch(worktree, nonGit)).toBeNull();
  });

  it('gitWorktreeRoot reports each tree distinctly', () => {
    expect(gitWorktreeRoot(worktree)).toBe(real(worktree));
    expect(gitWorktreeRoot(mainRepo)).toBe(real(mainRepo));
    expect(gitWorktreeRoot(nonGit)).toBeNull();
  });

  it('warning names both trees and the fix', () => {
    const msg = worktreeMismatchWarning(detectWorktreeIndexMismatch(worktree, mainRepo)!);
    expect(msg).toContain(real(worktree));
    expect(msg).toContain(real(mainRepo));
    expect(msg).toContain('codegraph init');
  });
});

/**
 * Regression tests for issue #926: a worktree-local index must not be falsely
 * flagged as a mismatch when the MCP tool call explicitly passes `projectPath`
 * pointing at that worktree.
 *
 * Two stale-cache bugs combined to produce the false positive:
 *
 *  Bug A — `projectCache` staleness: a prior tool call with `projectPath=wt`
 *  (before the worktree index existed) cached `wt → mainRepoCG`. After the
 *  worktree index was created the stale entry persisted, so `getCodeGraph(wt)`
 *  kept returning the main repo's CodeGraph.
 *
 *  Bug B — `worktreeMismatchCache` key collision: the mismatch cache was keyed
 *  on `startPath` alone. A call WITHOUT `projectPath` (where
 *  `startPath = defaultProjectHint = wt`, `indexRoot = mainRepo`) cached a
 *  legitimate mismatch under key "wt". A later call WITH `projectPath=wt`
 *  (where `indexRoot = wt`) hit the same key and returned the stale entry.
 *
 * Fix A: re-validate `projectCache` entries whose root is a *parent* of
 *        `projectPath`; evict when `findNearestCodeGraphRoot` now returns
 *        something closer.
 * Fix B: key `worktreeMismatchCache` on `${startPath}\0${indexRoot}` so the
 *        two calls above get independent entries.
 */
describe('worktree-local index not falsely flagged when projectPath is explicit (issue #926)', () => {
  let mainRepo: string;
  let worktree: string;
  let mainCg: CodeGraph;
  let worktreeCg: CodeGraph;

  beforeEach(async () => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-926-main-'));
    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(mainRepo, 'src'));
    fs.writeFileSync(path.join(mainRepo, 'src', 'a.ts'), 'export function mainFn() {}\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    mainCg = CodeGraph.initSync(mainRepo);
    await mainCg.indexAll();

    // Worktree nested inside the main checkout (mirrors the issue reporter's setup).
    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    // The worktree has its OWN .codegraph/ index (the scenario from #926).
    worktreeCg = CodeGraph.initSync(worktree);
    await worktreeCg.indexAll();
  });

  afterEach(() => {
    try { mainCg.destroy(); } catch { /* best effort */ }
    try { worktreeCg.destroy(); } catch { /* best effort */ }
    try { git(mainRepo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    fs.rmSync(mainRepo, { recursive: true, force: true });
  });

  it('no mismatch when the handler is initialized with the worktree-local index', async () => {
    // When the ToolHandler's own CodeGraph IS the worktree's index, tool calls
    // (with or without explicit projectPath) must not emit a mismatch notice.
    // getCodeGraph returns this.cg directly when resolvedRoot === this.cg.getProjectRoot(),
    // so this path exercises detectWorktreeIndexMismatch(worktree, worktree) → null.
    const handler = new ToolHandler(worktreeCg);
    handler.setDefaultProjectHint(worktree);
    const res = await handler.execute('codegraph_search', { query: 'mainFn', projectPath: worktree });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain('different git worktree');
  });

  it('mismatch IS reported when the main-repo handler is hinted at the worktree', async () => {
    // Baseline: a handler serving mainCg with hint=worktree should warn.
    const handler = new ToolHandler(mainCg);
    handler.setDefaultProjectHint(worktree);
    const res = await handler.execute('codegraph_search', { query: 'mainFn' });
    expect(res.content[0].text).toContain('different git worktree');
  });

  it('(startPath, indexRoot) cache key: worktree-hinted main-repo and worktree-local handlers produce independent mismatch entries', async () => {
    // Fix B: worktreeMismatchCache is keyed on `startPath\0indexRoot`, not
    // startPath alone. With the old single-key scheme, a mismatch cached by the
    // main-repo handler (key "worktree") would be returned verbatim by a later
    // call whose indexRoot is actually "worktree" itself — a false positive.
    //
    // Both handlers below share startPath = worktree (via defaultProjectHint)
    // but have different indexRoots (mainRepo vs worktree), so they must get
    // independent cache entries and produce opposite results.
    const mainHandler = new ToolHandler(mainCg);
    mainHandler.setDefaultProjectHint(worktree);

    const wtHandler = new ToolHandler(worktreeCg);
    wtHandler.setDefaultProjectHint(worktree);

    // mainHandler: startPath=worktree, indexRoot=mainRepo → mismatch
    const first = await mainHandler.execute('codegraph_search', { query: 'mainFn' });
    expect(first.content[0].text).toContain('different git worktree');

    // wtHandler: startPath=worktree, indexRoot=worktree → no mismatch
    // With the old bug (key = startPath only), both handlers sharing the same
    // startPath string would alias — but they have independent caches here,
    // so this directly tests that (worktree, worktree) produces null.
    const second = await wtHandler.execute('codegraph_search', { query: 'mainFn' });
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).not.toContain('different git worktree');
  });
});

/**
 * The detection above only helps if it reaches the agent. Agents call the read
 * tools (search/context/trace/…), almost never status — so the mismatch notice
 * has to ride on every read tool's result, not just status. These tests drive
 * the real `ToolHandler.execute` chokepoint against a real index whose default
 * project resolves UP from a nested worktree to the main checkout.
 */
describe('worktree mismatch surfaces on hot read tools (issue #155)', () => {
  let mainRepo: string;
  let worktree: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-tool-'));
    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(mainRepo, 'src'));
    fs.writeFileSync(path.join(mainRepo, 'src', 'a.ts'), 'export function mainOnly() { return 1; }\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    // The index lives in the MAIN checkout.
    cg = CodeGraph.initSync(mainRepo);
    await cg.indexAll();

    // Nested worktree, mirroring tools that place them under .claude/worktrees/<name>/.
    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try { cg.destroy(); } catch { /* best effort */ }
    try { git(mainRepo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    fs.rmSync(mainRepo, { recursive: true, force: true });
  });

  it('prefixes a compact notice on codegraph_search run from a nested worktree', async () => {
    handler.setDefaultProjectHint(worktree);
    const res = await handler.execute('codegraph_search', { query: 'mainOnly' });
    const text = res.content[0].text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain('different git worktree');
    expect(text).toContain(real(worktree));
    expect(text).toContain('codegraph init');
  });

  it('does NOT prefix when the default project is the main checkout itself', async () => {
    handler.setDefaultProjectHint(mainRepo);
    const res = await handler.execute('codegraph_search', { query: 'mainOnly' });
    expect(res.content[0].text).not.toContain('different git worktree');
  });

  it('still shows the verbose warning on codegraph_status', async () => {
    handler.setDefaultProjectHint(worktree);
    const res = await handler.execute('codegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('different git working tree');
    expect(text).toContain(real(worktree));
  });

  it('caches detection — a later tool call needs no further git spawn', async () => {
    handler.setDefaultProjectHint(worktree);
    // First call computes + caches the mismatch (this is the only git spawn).
    const first = await handler.execute('codegraph_search', { query: 'mainOnly' });
    expect(first.content[0].text).toContain('different git worktree');

    // Make git unreachable. A fresh detection would now return null (no notice);
    // the notice still appearing on a *different* tool proves it came from cache.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const second = await handler.execute('codegraph_explore', { query: 'mainOnly' });
      expect(second.content[0].text).toContain('different git worktree');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

/**
 * A long-lived MCP server (the shared daemon) cached its worktree-mismatch
 * verdict keyed only by the start path, and that cache was cleared only on
 * shutdown. So once the server decided "this worktree borrows the main
 * checkout's index" — true while the worktree had no `.codegraph/` of its own —
 * the verdict was pinned for the daemon's whole life. After the worktree got
 * its own index (the resolved index root flipped from the main checkout to the
 * worktree itself), the CLI saw the worktree's index but the MCP server kept
 * emitting the stale false warning until a restart (issue #926).
 *
 * The verdict depends on BOTH the start path and the resolved index root, so it
 * must be cached under both — a changed index root has to invalidate it. This
 * drives the real `ToolHandler` worktree-notice path across exactly that change
 * (the resolved index root flips when the server's default project is re-opened
 * onto the worktree's own index), with no mocking.
 */
describe('worktree mismatch verdict re-resolves when the index root changes (issue #926)', () => {
  let mainRepo: string;
  let worktree: string;
  let mainCg: CodeGraph;
  let worktreeCg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-926-'));
    git(mainRepo, 'init', '-q');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    git(mainRepo, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(mainRepo, 'src'));
    fs.writeFileSync(path.join(mainRepo, 'src', 'a.ts'), 'export function mainOnly() { return 1; }\n');
    git(mainRepo, 'add', '.');
    git(mainRepo, 'commit', '-q', '-m', 'init');

    // The long-lived server's default project starts as the MAIN checkout.
    mainCg = CodeGraph.initSync(mainRepo);
    await mainCg.indexAll();

    // Nested worktree that later gains its own index.
    worktree = path.join(mainRepo, 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    worktreeCg = CodeGraph.initSync(worktree);
    await worktreeCg.indexAll();

    handler = new ToolHandler(mainCg);
  });

  afterEach(() => {
    try { mainCg.destroy(); } catch { /* best effort */ }
    try { worktreeCg.destroy(); } catch { /* best effort */ }
    try { git(mainRepo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    fs.rmSync(mainRepo, { recursive: true, force: true });
  });

  it('drops the stale "borrowed the main index" warning once the index root flips to the worktree', async () => {
    // The server runs from inside the worktree, default project = main checkout.
    handler.setDefaultProjectHint(worktree);

    // Phase 1: the index genuinely belongs to a different working tree (the main
    // checkout) → warn, and cache that verdict.
    const before = await handler.execute('codegraph_status', {});
    expect(before.content[0].text).toContain('different git working tree');
    expect(before.content[0].text).toContain(real(mainRepo));

    // Phase 2: the worktree's own index is now the server's default project
    // (engine re-open → setDefaultCodeGraph). The resolved index root for the
    // SAME start path flipped to the worktree itself, so the verdict must be
    // recomputed to "no mismatch" — not served stale from before.
    handler.setDefaultCodeGraph(worktreeCg);

    const after = await handler.execute('codegraph_status', {});
    expect(after.content[0].text).not.toContain('different git working tree');
  });
});

/**
 * A nested repo (submodule / embedded clone) whose files the PARENT index
 * already covers must NOT be flagged as a borrowed worktree: indexing a
 * super-repo descends into its submodules and gitlinked clones, so a query run
 * from inside one resolves up to the parent index — which genuinely contains
 * that nested repo's symbols. The warning's premise is false there, and its
 * "run codegraph init -i" advice would fragment the unified index. (#1031, #1033)
 */
describe('detectWorktreeIndexMismatch — nested repos covered by the parent index (#1031, #1033)', () => {
  let parent: string;     // super-repo that owns the .codegraph index
  let subSource: string;  // separate repo used as the submodule source

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-parent-'));
    subSource = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-subsrc-'));
    for (const r of [parent, subSource]) {
      git(r, 'init', '-q');
      git(r, 'config', 'user.email', 'test@example.com');
      git(r, 'config', 'user.name', 'Test');
      git(r, 'config', 'commit.gpgsign', 'false');
    }
    fs.writeFileSync(path.join(subSource, 'lib.ts'), 'export const x = 1;\n');
    git(subSource, 'add', '.');
    git(subSource, 'commit', '-q', '-m', 'sub');
    fs.writeFileSync(path.join(parent, 'README.md'), '# parent\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(subSource, { recursive: true, force: true });
  });

  function addSubmodule(name: string): string {
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, name],
      { cwd: parent, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    git(parent, 'commit', '-q', '-m', 'add submodule');
    return path.join(parent, name);
  }

  function addBareGitlink(name: string): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'tool.ts'), 'export const y = 2;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'tool');
    git(parent, 'add', name); // records a 160000 gitlink, no .gitmodules
    git(parent, 'commit', '-q', '-m', 'gitlink');
    return dir;
  }

  it('does NOT flag an active submodule covered by the parent index', () => {
    const sub = addSubmodule('service-a');
    // The submodule IS its own working-tree root (so the old logic flagged it)…
    expect(gitWorktreeRoot(sub)).toBe(real(sub));
    // …but the parent index covers it, so there must be no warning.
    expect(detectWorktreeIndexMismatch(sub, parent)).toBeNull();
    expect(detectWorktreeIndexMismatch(path.join(sub, 'src'), parent)).toBeNull();
  });

  it('does NOT flag a bare gitlink (embedded clone, no .gitmodules) covered by the parent index', () => {
    const embedded = addBareGitlink('embedded');
    expect(gitWorktreeRoot(embedded)).toBe(real(embedded));
    expect(detectWorktreeIndexMismatch(embedded, parent)).toBeNull();
  });

  it('gitCommonDir differs for a nested repo vs the parent (the discriminator)', () => {
    const sub = addSubmodule('service-a');
    const subCommon = gitCommonDir(sub);
    const parentCommon = gitCommonDir(parent);
    expect(subCommon).not.toBeNull();
    expect(parentCommon).not.toBeNull();
    expect(subCommon).not.toBe(parentCommon); // different repository → suppress
  });

  it('still flags a genuine linked worktree (same repo, different branch)', () => {
    // A real worktree shares the parent's git common dir, so it stays flagged —
    // the suppression must not weaken the issue-#155 case.
    const wt = path.join(parent, 'wt');
    git(parent, 'worktree', 'add', '-q', '-b', 'feature', wt);
    try {
      expect(gitCommonDir(wt)).toBe(gitCommonDir(parent)); // SAME repository
      expect(detectWorktreeIndexMismatch(wt, parent)).not.toBeNull();
    } finally {
      try { git(parent, 'worktree', 'remove', '--force', wt); } catch { /* best effort */ }
    }
  });
});
