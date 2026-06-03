/**
 * Git Sync Hooks
 *
 * When the live file watcher is disabled (e.g. on WSL2 `/mnt/*` drives,
 * see watch-policy.ts), the CodeGraph index would otherwise go stale until
 * the user runs `codegraph sync` by hand. As an opt-in alternative, we can
 * install git hooks that refresh the index after the operations that change
 * files on disk: commit, merge (covers `git pull`), and checkout.
 *
 * The hooks run `codegraph sync` in the background so they never block git,
 * and are guarded by `command -v codegraph` so they no-op cleanly when the
 * CLI isn't on PATH. Our snippet is delimited by marker comments so install
 * is idempotent and removal preserves any user-authored hook content.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { stripMarkerBlock, isEffectivelyEmpty, chmodExecutable } from './hook-utils';

const MARKER_BEGIN = '# >>> codegraph sync hook >>>';
const MARKER_END = '# <<< codegraph sync hook <<<';

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout';

/** Hooks installed by default: commit, merge (git pull), and checkout. */
export const DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];

export interface GitHookResult {
  /** Hook names that were created or updated. */
  installed: GitHookName[];
  /** Resolved hooks directory, or null when not a git repo. */
  hooksDir: string | null;
  /** Reason nothing happened (e.g. not a git repository). */
  skipped?: string;
}

/**
 * Whether `projectRoot` is inside a git working tree. Returns false if git
 * isn't installed or the path isn't a repo.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * Resolve the git hooks directory for a project, honoring `core.hooksPath`
 * and git worktrees. Returns an absolute path, or null when not a repo.
 */
function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
  } catch {
    return null;
  }
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(): string {
  return [
    MARKER_BEGIN,
    '# Keeps the CodeGraph index fresh while the live file watcher is off',
    '# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.',
    '# Managed by codegraph; remove with `codegraph uninit` or delete this block.',
    'if command -v codegraph >/dev/null 2>&1; then',
    '  ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
    'fi',
    MARKER_END,
  ].join('\n');
}


/**
 * Install (or update) the CodeGraph sync hooks in a git repository.
 * Idempotent: re-running replaces our marker block rather than duplicating
 * it, and any user-authored hook content is preserved.
 */
export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    return { installed: [], hooksDir, skipped: 'could not access the git hooks directory' };
  }

  const block = markerBlock();
  const installed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    let content: string;

    if (fs.existsSync(file)) {
      // Strip any prior block, then re-append the current one.
      const base = stripMarkerBlock(fs.readFileSync(file, 'utf8'), MARKER_BEGIN, MARKER_END).replace(/\s*$/, '');
      content = base.length > 0
        ? `${base}\n\n${block}\n`
        : `#!/bin/sh\n${block}\n`;
    } else {
      content = `#!/bin/sh\n${block}\n`;
    }

    fs.writeFileSync(file, content);
    chmodExecutable(file);
    installed.push(hook);
  }

  return { installed, hooksDir };
}

/**
 * Remove the CodeGraph sync hooks. Strips only our marker block; deletes the
 * hook file entirely when nothing but a shebang remains, otherwise rewrites
 * the user's content untouched.
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(MARKER_BEGIN)) continue;

    const stripped = stripMarkerBlock(original, MARKER_BEGIN, MARKER_END);
    if (isEffectivelyEmpty(stripped)) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`);
      chmodExecutable(file);
    }
    removed.push(hook);
  }

  return { installed: removed, hooksDir };
}

/** Whether any CodeGraph sync hook is currently installed. */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return false;
  return hooks.some((hook) => {
    const file = path.join(hooksDir, hook);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER_BEGIN);
  });
}
