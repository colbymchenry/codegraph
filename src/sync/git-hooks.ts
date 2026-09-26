/**
 * Git Sync Hooks
 *
 * When the live file watcher is disabled (e.g. on WSL2 `/mnt/*` drives,
 * see watch-policy.ts), the CodeGraph index would otherwise go stale until
 * the user runs `codegraph sync` by hand. As an opt-in alternative, we can
 * install git hooks that refresh the index after the operations that change
 * files on disk: commit, merge (covers `git pull`), and checkout.
 *
 * The hooks run `codegraph sync <project root>` in the background so they
 * never block git, and are guarded by `command -v codegraph` so they no-op
 * cleanly when the CLI isn't on PATH. Git runs hooks from the top of the work
 * tree, so the block names its project root explicitly — a sub-project's
 * index (`packages/app/.codegraph`) would otherwise never be found. Each root
 * gets its own marker-delimited block, placed right after the shebang so a
 * user hook that ends in `exit` can't skip it; install is idempotent per root
 * and removal preserves any user-authored hook content.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const MARKER_BEGIN = '# >>> codegraph sync hook >>>';
const MARKER_END = '# <<< codegraph sync hook <<<';
/** Names the project root a block syncs. Blocks written before it have none. */
const ROOT_PREFIX = '# codegraph-root: ';
/** Interpreters our shell snippet can be added to. */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash']);

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
  /**
   * Existing hooks left untouched because they aren't shell scripts (a
   * `#!/usr/bin/env python3` hook can't run our snippet).
   */
  unsupported?: GitHookName[];
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
      timeout: 5000, // fail fast instead of hanging init/sync on a stuck git (#1139)
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
      timeout: 5000, // same rationale as isGitRepo
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
  } catch {
    return null;
  }
}

/**
 * The key a block records for its project: the resolved root with forward
 * slashes, which Git for Windows' sh also accepts.
 */
function rootKey(projectRoot: string): string {
  let resolved = path.resolve(projectRoot);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* keep the lexical path when it can't be resolved */
  }
  return resolved.split(path.sep).join('/');
}

/** The work tree's top level (as a {@link rootKey}), or null when unknown. */
function gitToplevelKey(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // same rationale as isGitRepo
    }).trim();
    return out ? rootKey(out) : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(root: string): string {
  return [
    MARKER_BEGIN,
    '# Keeps the CodeGraph index fresh while the live file watcher is off',
    '# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.',
    '# Managed by codegraph; remove with `codegraph uninit` or delete this block.',
    `${ROOT_PREFIX}${root}`,
    'if command -v codegraph >/dev/null 2>&1; then',
    `  ( codegraph sync ${shellQuote(root)} >/dev/null 2>&1 & ) >/dev/null 2>&1`,
    'fi',
    MARKER_END,
  ].join('\n');
}

type BlockOwner = (blockRoot: string | null) => boolean;

/**
 * Which blocks belong to the project being installed / removed / checked: the
 * one naming its root, and — for the work tree's top-level project only — a
 * block from an older install, which named no root and so synced from the
 * directory git runs hooks in.
 */
function ownerFor(projectRoot: string): BlockOwner {
  const root = rootKey(projectRoot);
  let toplevel: string | null | undefined;
  return (blockRoot) => {
    if (blockRoot !== null) return blockRoot === root;
    if (toplevel === undefined) toplevel = gitToplevelKey(projectRoot);
    return toplevel === root;
  };
}

/** The root each marker block in `content` names (null for an older block). */
function blockRoots(content: string): (string | null)[] {
  const roots: (string | null)[] = [];
  let current: string | null | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === MARKER_BEGIN) { current = null; continue; }
    if (current === undefined) continue;
    if (trimmed.startsWith(ROOT_PREFIX)) { current = trimmed.slice(ROOT_PREFIX.length); continue; }
    if (trimmed === MARKER_END) { roots.push(current); current = undefined; }
  }
  return roots;
}

/**
 * Remove the marker blocks `owns` claims (and the blank line that follows
 * one), leaving every other block and all user content in place.
 */
function stripMarkerBlocks(content: string, owns: BlockOwner): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== MARKER_BEGIN) {
      kept.push(lines[i]!);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end]!.trim() !== MARKER_END) end++;
    const block = lines.slice(i, end + 1);
    const rootLine = block.find((l) => l.trim().startsWith(ROOT_PREFIX));
    const blockRoot = rootLine ? rootLine.trim().slice(ROOT_PREFIX.length) : null;
    if (owns(blockRoot)) {
      if (lines[end + 1]?.trim() === '') end++;
    } else {
      kept.push(...block);
    }
    i = end;
  }
  return kept.join('\n');
}

/** Whether a hook's shebang names a shell (a hook with none runs under sh). */
function isShellHook(content: string): boolean {
  const first = content.split('\n', 1)[0]!.trim();
  if (!first.startsWith('#!')) return true;
  const words = first.slice(2).trim().split(/\s+/);
  let program = path.posix.basename(words[0] ?? '');
  if (program === 'env') program = path.posix.basename(words.slice(1).find((w) => !w.startsWith('-')) ?? '');
  return SHELL_INTERPRETERS.has(program);
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* chmod is a no-op / unsupported on some platforms (e.g. Windows) */
  }
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

  const block = markerBlock(rootKey(projectRoot));
  const owns = ownerFor(projectRoot);
  const installed: GitHookName[] = [];
  const unsupported: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    let content = `#!/bin/sh\n${block}\n`;

    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8');
      if (!isShellHook(existing)) {
        unsupported.push(hook);
        continue;
      }
      // Replace this root's prior block; go in right after the shebang so a
      // user hook that ends in `exit` or `exec` can't skip it.
      const base = stripMarkerBlocks(existing, owns).replace(/\s*$/, '');
      if (!isEffectivelyEmpty(base)) {
        const lines = base.split('\n');
        const shebang = lines[0]!.startsWith('#!') ? lines.shift()! : null;
        const rest = lines.join('\n').replace(/^\s*\n/, '');
        content = `${shebang ? `${shebang}\n` : ''}${block}\n\n${rest}\n`;
      }
    }

    fs.writeFileSync(file, content);
    chmodExecutable(file);
    installed.push(hook);
  }

  return unsupported.length > 0 ? { installed, hooksDir, unsupported } : { installed, hooksDir };
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

  const owns = ownerFor(projectRoot);
  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    if (!blockRoots(original).some(owns)) continue;

    const stripped = stripMarkerBlocks(original, owns);
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

/** Whether a CodeGraph sync hook is installed for this project root. */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return false;
  const owns = ownerFor(projectRoot);
  return hooks.some((hook) => {
    const file = path.join(hooksDir, hook);
    return fs.existsSync(file) && blockRoots(fs.readFileSync(file, 'utf8')).some(owns);
  });
}
