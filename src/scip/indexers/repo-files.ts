/**
 * The repo's file list as the adapters see it, and the folders that hold a
 * language's project marker (`go.mod`, `Cargo.toml`, `tsconfig.json`, …).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const NEVER = new Set(['node_modules', '.git', '.codegraph']);

/**
 * The repo's files (repo-relative, `/`-separated): tracked plus
 * untracked-but-not-ignored, so it sees what codegraph indexes; a tree walk
 * when this isn't a git checkout. `node_modules` never counts.
 */
export function repoFiles(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const files = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root, '');
  return files.filter(f => !f.split('/').some(seg => NEVER.has(seg)));
}

function walk(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (NEVER.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out;
}

/**
 * Folders (`.` for the root) holding `marker`, outside any `skip` folder.
 * `topmost` keeps only those not inside another (a Cargo workspace's members
 * are indexed with it).
 */
export function markerDirs(root: string, marker: string, opts: { topmost?: boolean; skip?: readonly string[] } = {}): string[] {
  const skip = new Set(opts.skip ?? []);
  const dirs = repoFiles(root)
    .filter(f => path.posix.basename(f) === marker && !f.split('/').slice(0, -1).some(seg => skip.has(seg)))
    .map(f => path.posix.dirname(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!opts.topmost) return dirs;
  const out: string[] = [];
  for (const d of dirs) if (!out.some(o => o === '.' || d.startsWith(`${o}/`))) out.push(d);
  return out;
}
