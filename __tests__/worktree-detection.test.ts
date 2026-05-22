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
} from '../src/sync/worktree';

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
