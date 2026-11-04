/**
 * Compare changed, indexed files with the working tree before counting symbols.
 * Unlike a committed-only diff, orphans' merge-base-to-working-tree diff permits
 * synced uncommitted edits: only an index hash that differs from disk is stale.
 * Deleted paths, paths without a files row, missing/unreadable files and symlinks
 * outside the project are skipped. Oversize files use the indexer's size stamp.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../db';
import { indexedHashInput, readBoundedSourceSync } from '../file-limits';
import { validatePathWithinRoot } from '../utils';
import { runGit } from './git-diff';

export interface FreshnessFile {
  path: string;
  status: string;
}

/** Project-relative stale paths, in diff order. */
export interface IndexCurrency {
  unsynced: string[];
}

/** Leave headroom for fixed arguments and quoting within each platform's argv limit. */
const GIT_ARGV_BYTES = 100 * 1024;
const GIT_ARGV_BYTES_WIN32 = 16 * 1024;
const LISTED_PATHS = 5;

/** Split path arguments without exceeding the budget, except for a single oversized path. */
export function freshnessBatches(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[][] {
  const budget = platform === 'win32' ? GIT_ARGV_BYTES_WIN32 : GIT_ARGV_BYTES;
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const rel of paths) {
    const size = Buffer.byteLength(rel) + 1;
    if (current.length > 0 && bytes + size > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(rel);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Relative diff paths only, never a path climbing out of the root. */
function isInsideRoot(rel: string): boolean {
  return rel !== '' && !rel.includes('\0') && !path.isAbsolute(rel) &&
    rel.split(/[\\/]/).every((part) => part !== '..');
}

/** Hash exactly the indexer's bounded content or size stamp, not mtime. */
function indexedHashOf(abs: string): string | null {
  try {
    const { stats, bytes } = readBoundedSourceSync(abs);
    return createHash('sha256')
      .update(indexedHashInput(stats.size, () => (bytes as Buffer).toString('utf8')))
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * Return stale indexed paths, or null if the database/git check cannot run.
 * Git comparisons are batched and literal. Their changed-path output does NOT
 * refuse uncommitted edits: every eligible file is compared by indexed hash.
 */
export function checkIndexCurrency(root: string, files: readonly FreshnessFile[]): IndexCurrency | null {
  const absRoot = path.resolve(root);
  const wanted = files.filter((file) => file.status !== 'deleted' && isInsideRoot(file.path));
  if (wanted.length === 0) return { unsynced: [] };

  const stored = new Map<string, string>();
  try {
    const conn = DatabaseConnection.open(getDatabasePath(absRoot), { readOnly: true });
    try {
      const select = conn.getDb().prepare('SELECT content_hash FROM files WHERE path = ?');
      for (const file of wanted) {
        const row = select.get(file.path) as { content_hash: string } | undefined;
        if (row) stored.set(file.path, row.content_hash);
      }
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }

  // Resolve containment before reading content; never follow an external symlink.
  const present = new Map<string, string>();
  for (const rel of stored.keys()) {
    const safe = validatePathWithinRoot(absRoot, rel, { readOnly: true });
    if (safe !== null && fs.existsSync(safe)) present.set(rel, safe);
  }
  for (const batch of freshnessBatches([...present.keys()])) {
    if (runGit(absRoot, [
      '--literal-pathspecs', 'diff', '--name-only', '-z', '--relative',
      '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...batch,
    ]) === null) return null;
  }

  const unsynced: string[] = [];
  for (const [rel, abs] of present) {
    const hash = indexedHashOf(abs);
    if (hash !== null && hash !== stored.get(rel)) unsynced.push(rel);
  }
  return { unsynced };
}

/** Bounded, project-relative sync guidance, or null when every checked file is fresh. */
export function currencyFailure(currency: IndexCurrency): string | null {
  const paths = currency.unsynced;
  if (paths.length === 0) return null;
  const listed = paths.slice(0, LISTED_PATHS).join(', ');
  const more = paths.length > LISTED_PATHS ? `, and ${paths.length - LISTED_PATHS} more` : '';
  return `the index has not caught up with ${paths.length} ${paths.length === 1 ? 'file' : 'files'}: ${listed}${more}. ` +
    'Let it sync (or run `codegraph sync`) and run again.';
}
