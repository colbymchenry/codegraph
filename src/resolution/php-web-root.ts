/**
 * The folder PHP's `$_SERVER['DOCUMENT_ROOT']` names, worked out from the
 * project's own includes when its `codegraph.json` sets no `webRoot` (#3298).
 *
 * The web server's configuration says which folder it serves, and that isn't
 * in the project. The includes are: `require $_SERVER['DOCUMENT_ROOT'] .
 * '/inc/header.php'` names a file under the web root, so the right folder is
 * the one under which those paths name files the project has. On a site that
 * serves its own root (velogrimpe.fr, 545 such includes), the project root
 * explains 421 of them and every other folder none.
 *
 * Every folder that holds a file with such an include, and each folder above
 * it, is a candidate. Its evidence is how many different paths, written in the
 * files under it, name a file under it. A file's includes take the candidate
 * at or above the file's folder with the most evidence, when that is at least
 * MIN_WEB_ROOT_EVIDENCE paths and at least WEB_ROOT_LEAD times any other
 * candidate's at or above the same folder. Anything less, a tie included,
 * leaves the folder with no web root: a guess would link the wrong file
 * wherever two folders hold one of the same name (`public/config.php` beside a
 * private `config.php` above it), and a missing link beats a wrong one. Only
 * candidates above a file count for it, since a page the server serves sits in
 * the folder it serves; a file outside the web root (an `includes/` beside
 * `public_html/`) gets none, and a project of two sites gets one for each.
 */
import * as path from 'path';

/** How many different paths a candidate must place on files before its folders' includes go under it. */
export const MIN_WEB_ROOT_EVIDENCE = 3;

/** How many times any rival candidate's evidence the winner's must be. */
export const WEB_ROOT_LEAD = 2;

/** The folder a project file is in, `/`-separated; '' is the project root. */
export function folderOf(file: string): string {
  const dir = path.posix.dirname(file.replace(/\\/g, '/'));
  return dir === '.' ? '' : dir;
}

/** `folder` and each folder above it, the project root ('') last. */
function foldersAbove(folder: string): string[] {
  const out: string[] = [];
  let dir = folder;
  for (;;) {
    out.push(dir);
    if (dir === '') return out;
    const up = path.posix.dirname(dir);
    dir = up === '.' ? '' : up;
  }
}

/**
 * `written` (the path an include appends to the web root, `inc/header.php`)
 * placed under the web root `root` ('' for the project root), exactly as
 * written; null when it leaves the project.
 */
export function underWebRoot(root: string, written: string): string | null {
  const target = path.posix.normalize(path.posix.join(root || '.', written));
  return target === '..' || target.startsWith('../') ? null : target;
}

/**
 * Each folder holding a file with a `$_SERVER['DOCUMENT_ROOT']` include → the
 * web root its files' includes go under, or null (see the module comment).
 * `includes` are each include's file and the path it appends to the web root;
 * `isFile` says whether a project-relative path names a file of the project.
 */
export function inferPhpWebRoots(
  includes: ReadonlyArray<{ filePath: string; written: string }>,
  isFile: (relPath: string) => boolean
): Map<string, string | null> {
  const byFolder = new Map<string, Set<string>>();
  for (const { filePath, written } of includes) {
    const folder = folderOf(filePath);
    let paths = byFolder.get(folder);
    if (!paths) byFolder.set(folder, (paths = new Set()));
    paths.add(written);
  }
  // The different paths written in the files under each candidate.
  const writtenUnder = new Map<string, Set<string>>();
  const above = new Map<string, string[]>();
  for (const [folder, paths] of byFolder) {
    const candidates = foldersAbove(folder);
    above.set(folder, candidates);
    for (const c of candidates) {
      let under = writtenUnder.get(c);
      if (!under) writtenUnder.set(c, (under = new Set()));
      for (const p of paths) under.add(p);
    }
  }
  const evidence = new Map<string, number>();
  for (const [c, paths] of writtenUnder) {
    let n = 0;
    for (const p of paths) {
      const target = underWebRoot(c, p);
      if (target !== null && isFile(target)) n++;
    }
    evidence.set(c, n);
  }
  const roots = new Map<string, string | null>();
  for (const [folder, candidates] of above) {
    let best: string | null = null;
    let bestN = 0;
    let rivalN = 0;
    for (const c of candidates) {
      const n = evidence.get(c) ?? 0;
      if (n > bestN) {
        rivalN = bestN;
        best = c;
        bestN = n;
      } else if (n > rivalN) {
        rivalN = n;
      }
    }
    const clear = best !== null && bestN >= MIN_WEB_ROOT_EVIDENCE && bestN >= WEB_ROOT_LEAD * rivalN;
    roots.set(folder, clear ? best : null);
  }
  return roots;
}

/** What a snapshot reads while `codegraph.json` names the web root itself. */
export const CONFIGURED_WEB_ROOT = 'webRoot';

/**
 * A snapshot of the web roots resolution placed PHP's
 * `$_SERVER['DOCUMENT_ROOT']` includes under, for a later sync to compare:
 * CONFIGURED_WEB_ROOT under a `codegraph.json` `webRoot`, else each folder
 * holding such an include → its inferred root (null for none), as JSON.
 */
export function phpWebRootSnapshot(configured: string | null, inferred: ReadonlyMap<string, string | null>): string {
  if (configured !== null) return CONFIGURED_WEB_ROOT;
  return JSON.stringify(Object.fromEntries([...inferred].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/**
 * Whether the web roots moved for files a sync never touched, between two
 * snapshots (see phpWebRootSnapshot): `codegraph.json`'s `webRoot` came or
 * went, or a folder both know takes another root now. A folder only one knows
 * holds files the sync added, changed or removed, which it resolves anyway.
 */
export function phpWebRootsMoved(before: string, now: string): boolean {
  if (before === now) return false;
  if (before === CONFIGURED_WEB_ROOT || now === CONFIGURED_WEB_ROOT) return true;
  let was: Record<string, unknown>;
  let is: Record<string, unknown>;
  try {
    was = JSON.parse(before) as Record<string, unknown>;
    is = JSON.parse(now) as Record<string, unknown>;
  } catch {
    return true;
  }
  if (!was || typeof was !== 'object' || !is || typeof is !== 'object') return true;
  return Object.keys(is).some((folder) => Object.prototype.hasOwnProperty.call(was, folder) && was[folder] !== is[folder]);
}
