/**
 * Git Worktree Awareness
 *
 * A CodeGraph index lives in a `.codegraph/` directory and is resolved by
 * walking up parent directories to the nearest one (see
 * `findNearestCodeGraphRoot`). That walk is unaware of git worktrees: when a
 * worktree is created *inside* the main checkout (e.g. some tools place them
 * under `.gitignore`d paths like `.claude/worktrees/<name>/`), a command run
 * from the worktree walks up and silently resolves the MAIN checkout's index.
 *
 * Every query then returns results from the main tree's code — usually a
 * different branch — rather than the worktree the user is actually editing.
 * Symbols added or changed only in the worktree are invisible. This module
 * detects that "borrowed index" situation so callers can warn about it.
 *
 * Detection is best-effort: when git is unavailable or the path isn't a repo,
 * it reports "no mismatch" and callers carry on unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Absolute, symlink-resolved toplevel of the git working tree that `dir`
 * belongs to, or null when `dir` isn't inside a git repo (or git is missing).
 *
 * `git rev-parse --show-toplevel` returns the per-worktree root: the main
 * checkout and each linked worktree report their own distinct directory, which
 * is exactly the distinction this module relies on.
 */
export function gitWorktreeRoot(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? realpath(out) : null;
  } catch {
    return null;
  }
}

export interface WorktreeIndexMismatch {
  /** The git working tree the command was run from. */
  worktreeRoot: string;
  /** The (different) working tree whose `.codegraph` index is being used. */
  indexRoot: string;
}

/**
 * Detect when `startPath` lives in one git working tree but the resolved
 * CodeGraph index (`indexRoot`) belongs to a *different* working tree.
 *
 * Returns null — meaning "nothing to warn about" — when:
 *   - `startPath` isn't in a git repo (or git is unavailable),
 *   - the index already lives in `startPath`'s own working tree, or
 *   - `indexRoot` isn't itself a working-tree root (an unrelated parent dir
 *     that merely happens to contain a `.codegraph/`), which keeps non-git
 *     and monorepo-subdir layouts from producing false warnings.
 */
export function detectWorktreeIndexMismatch(
  startPath: string,
  indexRoot: string,
): WorktreeIndexMismatch | null {
  const worktreeRoot = gitWorktreeRoot(startPath);
  if (!worktreeRoot) return null;

  const resolvedIndexRoot = realpath(indexRoot);
  if (worktreeRoot === resolvedIndexRoot) return null;

  // Only flag it when the index root is itself a real working-tree root. This
  // distinguishes "borrowed another worktree's index" from "index sits in a
  // plain ancestor directory", and avoids warning outside git entirely.
  if (gitWorktreeRoot(resolvedIndexRoot) !== resolvedIndexRoot) return null;

  return { worktreeRoot, indexRoot: resolvedIndexRoot };
}

/** One-line-per-fact warning describing a detected mismatch. */
export function worktreeMismatchWarning(m: WorktreeIndexMismatch): string {
  return (
    `This CodeGraph index belongs to a different git working tree.\n` +
    `  Running in: ${m.worktreeRoot}\n` +
    `  Index from: ${m.indexRoot}\n` +
    `Results reflect that tree's code (often a different branch), not this worktree — ` +
    `symbols changed only here are missing. Run "codegraph init -i" in this worktree ` +
    `for a worktree-local index.`
  );
}

/**
 * Compact, single-line variant for prefixing a tool's result. Read tools
 * return their answer inline, so the heads-up has to ride on the same payload
 * the agent is already reading — a multi-line block would bury the result.
 */
export function worktreeMismatchNotice(m: WorktreeIndexMismatch): string {
  return (
    `⚠ CodeGraph results below come from a different git worktree (${m.indexRoot}), ` +
    `not where you're working (${m.worktreeRoot}) — they may reflect another branch, ` +
    `and symbols changed only here are missing. Run "codegraph init -i" here for a ` +
    `worktree-local index.`
  );
}

/** Resolve symlinks where possible so tmp/realpath quirks don't break equality. */
function realpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}
