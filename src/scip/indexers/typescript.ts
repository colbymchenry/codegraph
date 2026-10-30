/**
 * scip-typescript (https://github.com/sourcegraph/scip-typescript) for TS/JS.
 *
 * A repo with several TS projects (a tsconfig.json / jsconfig.json per
 * package, as in vscode's `src/` + one per extension) is split by project
 * size. scip-typescript builds a project's whole type-checked program in
 * memory, and one process over all of them runs out of heap on a large
 * monorepo; but a process per project pays the TypeScript start-up cost dozens
 * of times. So: a heavy project runs alone with a large heap; light projects
 * are packed into batches — one process each — that run in parallel with a
 * small heap. A batch that fails is retried one project at a time, so one
 * broken project doesn't cost its batch-mates. A repo with one project (or
 * none) is a single run; without a tsconfig.json it infers one (plain JS).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IndexerRun, IndexerSpec } from './index';
import { repoFiles } from './repo-files';

const has = (root: string, f: string) => fs.existsSync(path.join(root, f));
const PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json']);
export const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Projects with at least this many source files run alone, with the big heap. */
const HEAVY_FILES = 1500;
/** Light projects are packed into batches of up to this many source files (and projects). */
const BATCH_FILES = 1500;
const BATCH_PROJECTS = 16;
/** Heap for a light batch; small enough that several run side by side. */
const LIGHT_HEAP_MB = 3072;

/** Lockfile → the command that installs what it pins. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm ci'], ['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'], ['bun.lock', 'bun install'], ['bun.lockb', 'bun install'],
];

/**
 * A lockfile but no node_modules: the compiler can't load the dependencies'
 * types, so calls into them read as unknown and some project calls on their
 * values go unresolved. Worth a warning that says how to fix it.
 */
function missingDependencies(root: string): string | undefined {
  const lock = LOCKFILES.find(([f]) => has(root, f));
  if (!lock || has(root, 'node_modules')) return undefined;
  return `${lock[0]} but no node_modules — calls into dependencies won't resolve; run \`${lock[1]}\` and reindex`;
}

function hasWorkspaces(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/** Directories (`.` for the root) holding a tsconfig.json / jsconfig.json. */
export function tsProjects(root: string, files = repoFiles(root)): string[] {
  const dirs = files.filter(f => PROJECT_FILES.has(path.posix.basename(f))).map(f => path.posix.dirname(f));
  return [...new Set(dirs)].sort();
}

/** The deepest of `byDepth` (projects, longest first) containing `file`. */
function ownerOf(byDepth: readonly string[], file: string): string | undefined {
  return byDepth.find(p => p === '.' || file.startsWith(`${p}/`));
}

/** Source files per project, each file counted once — for the deepest project containing it. */
export function projectWeights(projects: string[], files: string[]): Map<string, number> {
  const weights = new Map(projects.map(p => [p, 0]));
  const byDepth = [...projects].sort((a, b) => b.length - a.length);
  for (const f of files) {
    if (!SOURCE.test(f)) continue;
    const owner = ownerOf(byDepth, f);
    if (owner) weights.set(owner, weights.get(owner)! + 1);
  }
  return weights;
}

function heapEnv(mb: number): Record<string, string> {
  if (process.env.NODE_OPTIONS?.includes('--max-old-space-size')) return {};
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${mb}`.trim() };
}

/**
 * Node's default heap is far below what a large TS program needs (vscode's
 * `src/`: over 6 GB). A heavy run may use 60% of physical memory unless
 * NODE_OPTIONS already sets a heap; `scip.typescript.env` overrides both.
 */
const bigHeapMb = () => Math.floor((os.totalmem() * 0.6) / (1024 * 1024));

/** Splits projects into heavy runs (alone) and light batches (in parallel), in that order. */
export function planRuns(root: string, projects: string[], weights: Map<string, number>, outFile: string): IndexerRun[] {
  let part = 0;
  const run = (dirs: string[], light: boolean): IndexerRun => {
    const output = `${outFile}.part${part++}`;
    const args = ['index', '--output', output, ...dirs];
    if (dirs.every(d => !has(path.join(root, d), 'tsconfig.json'))) args.push('--infer-tsconfig'); // jsconfig-only
    return {
      label: dirs.length === 1 ? dirs[0]! : `${dirs[0]} (+${dirs.length - 1} more)`,
      args, output, light,
      env: heapEnv(light ? Math.min(LIGHT_HEAP_MB, bigHeapMb()) : bigHeapMb()),
    };
  };
  const heavy = projects.filter(p => weights.get(p)! >= HEAVY_FILES).sort((a, b) => weights.get(b)! - weights.get(a)!);
  const runs = heavy.map(p => run([p], false));
  // A batch mixes only projects that read their config the same way (--infer-tsconfig is per process).
  for (const inferred of [false, true]) {
    const light = projects.filter(p => weights.get(p)! < HEAVY_FILES && !has(path.join(root, p), 'tsconfig.json') === inferred);
    let batch: string[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const r = run(batch, true);
      if (batch.length > 1) r.fallback = batch.map(p => run([p], true));
      runs.push(r);
      batch = [];
      size = 0;
    };
    for (const p of light) {
      if (batch.length > 0 && (size + weights.get(p)! > BATCH_FILES || batch.length >= BATCH_PROJECTS)) flush();
      batch.push(p);
      size += weights.get(p)!;
    }
    flush();
  }
  return runs;
}

export const typescriptIndexer: IndexerSpec = {
  lang: 'typescript',
  tools: ['scip-typescript'],
  codegraphLanguages: ['typescript', 'javascript', 'tsx', 'jsx'],
  detect: root => has(root, 'tsconfig.json') || has(root, 'jsconfig.json') || has(root, 'package.json'),
  cmd: 'scip-typescript',
  invocation(root, outFile) {
    const files = repoFiles(root);
    const projects = tsProjects(root, files);
    const warning = missingDependencies(root);
    if (projects.length > 1) return { runs: planRuns(root, projects, projectWeights(projects, files), outFile), warning };
    const args = ['index', '--output', outFile];
    if (has(root, 'pnpm-workspace.yaml')) args.push('--pnpm-workspaces');
    else if (has(root, 'yarn.lock') && hasWorkspaces(root)) args.push('--yarn-workspaces');
    else if (!has(root, 'tsconfig.json')) args.push('--infer-tsconfig');
    return { runs: [{ label: 'typescript', args, output: outFile, env: heapEnv(bigHeapMb()) }], warning };
  },
};
