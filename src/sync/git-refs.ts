/**
 * Git helpers for comparing refs (`codegraph diff`). Every call is bounded and
 * returns null / throws a plain Error with guidance instead of hanging: the
 * same posture as `worktree.ts`.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[], opts: { input?: Buffer; timeout?: number } = {}): Buffer {
  return execFileSync('git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: opts.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: 512 * 1024 * 1024,
    ...(opts.input ? { input: opts.input } : {}),
  });
}

/** Full commit sha for a ref, or null when it does not name a commit. */
export function resolveRef(cwd: string, ref: string): string | null {
  try {
    const out = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString('utf8').trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Best common ancestor of two commits, or null (unrelated histories). */
export function mergeBase(cwd: string, a: string, b: string): string | null {
  try {
    const out = git(cwd, ['merge-base', a, b]).toString('utf8').trim();
    return out || null;
  } catch {
    return null;
  }
}

export function isShallowRepo(cwd: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true';
  } catch {
    return false;
  }
}

/** Local branch names, newest commit first. */
export function listLocalBranches(cwd: string, pattern?: string): string[] {
  try {
    const out = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']);
    const names = out.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (!pattern) return names;
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return names.filter((n) => re.test(n));
  } catch {
    return [];
  }
}

/** Parent commit of a commit (first parent), or null for a root commit. */
export function parentOf(cwd: string, sha: string): string | null {
  return resolveRef(cwd, `${sha}^`);
}

/** Commits in `base..tip`, oldest first; `firstParent` follows only the branch's own line. */
export function commitsBetween(cwd: string, base: string, tip: string, firstParent = false): string[] {
  try {
    const args = ['rev-list', '--reverse', ...(firstParent ? ['--first-parent'] : []), `${base}..${tip}`];
    return git(cwd, args).toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Subject line of a commit. */
export function subjectOf(cwd: string, sha: string): string {
  try {
    return git(cwd, ['log', '-1', '--format=%s', sha]).toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Would `git merge` of `other` into `ours` conflict textually? Uses
 * `git merge-tree --write-tree` (git >= 2.38); null when unavailable.
 */
export function textualMergeConflicts(cwd: string, ours: string, other: string): boolean | null {
  try {
    git(cwd, ['merge-tree', '--write-tree', '--no-messages', ours, other]);
    return false;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 1 ? true : null;
  }
}

/**
 * Would cherry-picking `commit` onto `onto` conflict textually? Simulated with
 * `git merge-tree --write-tree --merge-base=<parent>` (git >= 2.38), which
 * touches neither the working tree nor any ref. Null when it cannot be told.
 */
export function textualCherryPickConflicts(cwd: string, onto: string, commit: string): boolean | null {
  const parent = parentOf(cwd, commit);
  if (!parent) return null;
  try {
    git(cwd, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${parent}`, onto, commit]);
    return false;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 1 ? true : null;
  }
}

/** Number of parents of a commit (2+ means a merge commit). */
export function parentCount(cwd: string, sha: string): number {
  try {
    const out = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).toString('utf8').trim().split(/\s+/);
    return Math.max(0, out.length - 1);
  } catch {
    return 0;
  }
}

/**
 * Commits reachable from `tip` but not from `exclude` whose change added or
 * removed the text `needle` in `file`, oldest first. Used to name the commit
 * that introduced a symbol a cherry-pick is missing.
 */
export function commitsIntroducing(
  cwd: string,
  exclude: string,
  tip: string,
  needle: string,
  file: string,
): Array<{ sha: string; subject: string }> {
  try {
    const out = git(cwd, [
      'log', '--reverse', '--format=%H%x09%s', '-F', `-S${needle}`, `${exclude}..${tip}`, '--', file,
    ]).toString('utf8');
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha = '', ...rest] = line.split('\t');
        return { sha, subject: rest.join('\t') };
      });
  } catch {
    return [];
  }
}

/**
 * Export the tree of a commit into `destDir` (must exist). Plain git, no
 * `tar`: a throwaway index file holds the commit's tree and `checkout-index`
 * writes it out, which behaves the same on Windows, macOS and Linux.
 */
export function archiveCommit(cwd: string, sha: string, destDir: string): void {
  const indexFile = path.join(os.tmpdir(), `codegraph-ref-index-${process.pid}-${sha.slice(0, 12)}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    run(['read-tree', sha]);
    const prefix = destDir.replace(/\\/g, '/').replace(/\/?$/, '/');
    run(['checkout-index', '-a', '-f', `--prefix=${prefix}`]);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}
