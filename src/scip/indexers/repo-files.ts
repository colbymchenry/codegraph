/** The repo's file list as the adapters see it. */

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
    { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
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
