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
      windowsHide: true,
      // Bounded like every git call in extraction/: this runs (memoized) on
      // the daemon's main event loop, where an unbounded hang would trip the
      // 60s liveness watchdog and SIGKILL a healthy daemon (#1139).
      timeout: 5000,
    }).trim();
    return out ? realpath(out) : null;
  } catch {
    return null;
  }
}

/**
 * Absolute, symlink-resolved git **common** directory for `dir` — the shared
 * `.git` that all worktrees of one repository point at. Linked worktrees of the
 * same repo report the SAME common dir; a submodule or an embedded clone is a
 * DIFFERENT repository and reports its own (`…/.git/modules/<name>` or its own
 * `.git`). That distinction is what separates a genuine "borrowed worktree"
 * from a nested repo the parent index already covers. Null when not a repo.
 */
export function gitCommonDir(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // same rationale as gitWorktreeRoot
    }).trim();
    if (!out) return null;
    // `--git-common-dir` is relative to cwd unless already absolute.
    return realpath(path.isAbsolute(out) ? out : path.resolve(dir, out));
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
  if (sameDirectory(worktreeRoot, resolvedIndexRoot)) return null;

  // Only flag it when the index root is itself a real working-tree root. This
  // distinguishes "borrowed another worktree's index" from "index sits in a
  // plain ancestor directory", and avoids warning outside git entirely.
  const indexWorktreeRoot = gitWorktreeRoot(resolvedIndexRoot);
  if (!indexWorktreeRoot || !sameDirectory(indexWorktreeRoot, resolvedIndexRoot)) return null;

  // Don't flag a nested repo (submodule / embedded clone) that `indexRoot`'s
  // index ALREADY covers: indexing a super-repo descends into its submodules
  // and gitlinked clones, so a query run from inside one resolves up to the
  // parent index — whose graph *does* contain that nested repo's files. The
  // warning's premise ("results are a different branch; symbols changed only
  // here are missing") is false there, and its "codegraph init" advice would
  // needlessly fragment the unified workspace index. A genuine borrowed
  // worktree and the index root are the SAME repository (they share a git
  // common dir); a submodule/embedded clone is a DIFFERENT repository and does
  // not — so suppress only when the two clearly differ. (#1031, #1033)
  const worktreeCommon = gitCommonDir(worktreeRoot);
  const indexCommon = gitCommonDir(resolvedIndexRoot);
  if (worktreeCommon && indexCommon && !sameDirectory(worktreeCommon, indexCommon)) return null;

  return { worktreeRoot, indexRoot: resolvedIndexRoot };
}

/** A git repository of its own nested below an index root. */
export interface NestedRepository {
  /** The nested repository's working-tree root. */
  root: string;
  /** `root` relative to the index root, POSIX — the prefix its files carry in that index. */
  relPath: string;
}

/**
 * The repository `startPath` belongs to when it is a DIFFERENT git repository
 * nested strictly below `indexRoot` — an embedded clone, a submodule, a
 * gitignored checkout. The up-walk to the nearest `.codegraph/` crosses its
 * boundary without noticing, and the ancestor's index may or may not hold its
 * files, so the caller has to ask that index before answering for it (#2110).
 *
 * Returns null — nothing to check — when:
 *   - `startPath` isn't in a git repo (or git is unavailable),
 *   - its repository root is the index root or above it (an ordinary
 *     subdirectory; a monorepo sub-project with its own index), or
 *   - it is a linked worktree of the index root's OWN repository (same git
 *     common dir): the #155 borrowed-worktree case, warned about, not refused.
 */
export function nestedRepositoryBelow(startPath: string, indexRoot: string): NestedRepository | null {
  // git needs an existing directory to run in: a file, or a sub-path that does
  // not exist yet, belongs to the repository of its nearest existing directory.
  let dir = path.resolve(startPath);
  while (!isDirectory(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const repoRoot = gitWorktreeRoot(dir);
  if (!repoRoot) return null;

  // The on-disk spelling of both ends (`realpathSync.native` normalizes case on
  // macOS and Windows), so `relPath` matches the paths the index stored.
  const rel = path.relative(nativeRealpath(indexRoot), nativeRealpath(repoRoot));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;

  const repoCommon = gitCommonDir(repoRoot);
  if (!repoCommon) return null;
  const indexCommon = gitCommonDir(realpath(indexRoot));
  if (indexCommon && sameDirectory(repoCommon, indexCommon)) return null;
  return { root: repoRoot, relPath: rel.split(path.sep).join('/') };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function nativeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return realpath(p);
  }
}

/**
 * Whether two paths name one directory, however each is spelled. For
 * comparing only: the paths this module returns keep their own spelling.
 *
 * git answers with the on-disk spelling (a `subst` drive and links followed,
 * the case stored on disk), while callers hand in theirs: VS Code and Cursor
 * pass a lowercase drive letter, a `subst` drive is a second name for a
 * folder, and NTFS ignores case. Compared as strings, one directory looked
 * like two, so a linked worktree spelled unlike git lost the borrowed-index
 * warning and was refused as a repository of its own (#2517). The identity is
 * `canonicalProjectRoot`'s — the native realpath, lowercased on Windows —
 * falling back to the JS realpath where the native call fails.
 */
function sameDirectory(a: string, b: string): boolean {
  return a === b || directoryIdentity(a) === directoryIdentity(b);
}

function directoryIdentity(p: string): string {
  const real = nativeRealpath(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * The way out of a borrowed index: one built in the worktree itself. A person
 * at the CLI is told to build it. An agent is told the user can: indexing is
 * the user's decision, and the server instructions tell the agent not to run
 * `codegraph init` itself, so a tool result must not tell it to.
 */
function worktreeIndexAdvice(audience: 'user' | 'agent'): string {
  return audience === 'agent'
    ? 'The user can run "codegraph init" in this worktree for a worktree-local index.'
    : 'Run "codegraph init" in this worktree for a worktree-local index.';
}

/**
 * One-line-per-fact warning describing a detected mismatch: `codegraph status`
 * prints it for the user, and `codegraph_status` shows the agent's wording.
 */
export function worktreeMismatchWarning(
  m: WorktreeIndexMismatch,
  audience: 'user' | 'agent' = 'user',
): string {
  return (
    `This CodeGraph index belongs to a different git working tree.\n` +
    `  Running in: ${m.worktreeRoot}\n` +
    `  Index from: ${m.indexRoot}\n` +
    `Results reflect that tree's code (often a different branch), not this worktree — ` +
    `symbols changed only here are missing. ${worktreeIndexAdvice(audience)}`
  );
}

/**
 * Compact, single-line variant for prefixing a tool's result. Read tools
 * return their answer inline, so the heads-up has to ride on the same payload
 * the agent is already reading — a multi-line block would bury the result.
 * Its reader is an agent, through MCP, the prompt hook or the `codegraph
 * explore` and `codegraph node` CLI.
 */
export function worktreeMismatchNotice(m: WorktreeIndexMismatch): string {
  return (
    `⚠ CodeGraph results below come from a different git worktree (${m.indexRoot}), ` +
    `not where you're working (${m.worktreeRoot}) — they may reflect another branch, ` +
    `and symbols changed only here are missing. ${worktreeIndexAdvice('agent')}`
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
