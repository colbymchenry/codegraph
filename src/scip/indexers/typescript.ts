/**
 * scip-typescript (https://github.com/sourcegraph/scip-typescript) for TS/JS.
 *
 * A repo with several TS projects (a tsconfig.json / jsconfig.json per
 * package, as in vscode's `src/` + one per extension) is indexed one project
 * per process: scip-typescript builds each project's whole type-checked
 * program in memory, and a single process over all of them runs out of heap on
 * large monorepos. Split, peak memory is the largest single project. A repo
 * with one project (or none) is a single run, as before; without a
 * tsconfig.json it infers one (plain-JS projects).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IndexerRun, IndexerSpec } from './index';

const has = (root: string, f: string) => fs.existsSync(path.join(root, f));
const PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json']);
const NEVER = new Set(['node_modules', '.git', '.codegraph']);

function hasWorkspaces(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * Directories (repo-relative, `/`-separated, `.` for the root) holding a TS
 * project file. Asks git first — tracked plus untracked-but-not-ignored, so it
 * sees what codegraph indexes; walks the tree when this isn't a git checkout.
 */
export function tsProjects(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*tsconfig.json', '*jsconfig.json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root, '');
  const dirs = files
    .filter(f => PROJECT_FILES.has(path.posix.basename(f)) && !f.split('/').some(seg => NEVER.has(seg)))
    .map(f => path.posix.dirname(f));
  return [...new Set(dirs)].sort();
}

/**
 * scip-typescript holds a project's whole type-checked program in memory, and
 * Node's default heap is far below what a large one needs (vscode's `src/`:
 * over 6 GB). Allow 60% of physical memory unless NODE_OPTIONS is already set;
 * `scip.typescript.env` in codegraph.json overrides this too.
 */
function heapEnv(): Record<string, string> {
  if (process.env.NODE_OPTIONS?.includes('--max-old-space-size')) return {};
  const mb = Math.floor((os.totalmem() * 0.6) / (1024 * 1024));
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${mb}`.trim() };
}

function walk(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (NEVER.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, child));
    else if (PROJECT_FILES.has(e.name)) out.push(child);
  }
  return out;
}

export const typescriptIndexer: IndexerSpec = {
  lang: 'typescript',
  tool: 'scip-typescript',
  codegraphLanguages: ['typescript', 'javascript', 'tsx', 'jsx'],
  detect: root => has(root, 'tsconfig.json') || has(root, 'jsconfig.json') || has(root, 'package.json'),
  cmd: 'scip-typescript',
  invocation(root, outFile) {
    const projects = tsProjects(root);
    if (projects.length > 1) {
      const runs: IndexerRun[] = projects.map((dir, i) => {
        const output = `${outFile}.part${i}`;
        const args = ['index', '--output', output, dir];
        if (!has(path.join(root, dir), 'tsconfig.json')) args.push('--infer-tsconfig'); // jsconfig-only project
        return { label: dir, args, output };
      });
      return { runs, env: heapEnv() };
    }
    const args = ['index', '--output', outFile];
    if (has(root, 'pnpm-workspace.yaml')) args.push('--pnpm-workspaces');
    else if (has(root, 'yarn.lock') && hasWorkspaces(root)) args.push('--yarn-workspaces');
    else if (!has(root, 'tsconfig.json')) args.push('--infer-tsconfig');
    return { runs: [{ label: 'typescript', args, output: outFile }], env: heapEnv() };
  },
};
