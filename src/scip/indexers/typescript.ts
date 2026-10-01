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
 *
 * Preferred over all of that when installed: TypeScript ≥ 7.1 (the native
 * compiler, tsgo) through its API — see tsgo-index.ts. It type-checks several
 * times faster in far less memory, so every project runs in one process.
 * Found in the project's node_modules, else codegraph's tools folder, else the
 * global npm root (see findTsgo).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IndexerRun, IndexerSpec } from './index';
import { repoFiles } from './repo-files';

const has = (root: string, f: string) => fs.existsSync(path.join(root, f));
const PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Projects with at least this many source files run alone, with the big heap. */
const HEAVY_FILES = 1500;
/** Light projects are packed into batches of up to this many source files (and projects). */
const BATCH_FILES = 1500;
const BATCH_PROJECTS = 16;
/** Heap for a light batch; small enough that several run side by side. */
const LIGHT_HEAP_MB = 3072;
/** The first TypeScript whose API tsgo-index.ts is written against. */
const TSGO_MIN = [7, 1];

/** Lockfile → the command that installs what it pins. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm ci'], ['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'], ['bun.lock', 'bun install'], ['bun.lockb', 'bun install'],
];

/**
 * A lockfile but no node_modules: the compiler can't load the dependencies'
 * types, so calls into them read as unknown and some project calls on their
 * values go unresolved. Worth a warning that says how to fix it.
 */
export function missingDependencies(root: string): string | undefined {
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

/** Source files per project, each file counted once — for the deepest project containing it. */
export function projectWeights(projects: string[], files: string[]): Map<string, number> {
  const weights = new Map(projects.map(p => [p, 0]));
  const byDepth = [...projects].sort((a, b) => b.length - a.length);
  for (const f of files) {
    if (!SOURCE.test(f)) continue;
    const owner = byDepth.find(p => p === '.' || f.startsWith(`${p}/`));
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

/** The version of the package at `dir`; null when there is none. An unreadable package.json is an error, not "absent". */
export function packageVersion(dir: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error(`${dir}/package.json has no version`);
  return version;
}

/**
 * A TypeScript installed for codegraph alone, so a 7.1 pre-release needn't be
 * the machine's global `tsc`: `npm i --prefix ~/.codegraph/tools typescript@next`.
 */
export function toolsDir(): string {
  return path.join(process.env.CODEGRAPH_INSTALL_DIR || path.join(os.homedir(), '.codegraph'), 'tools');
}

/**
 * Where tsgo-index can load TypeScript ≥ 7.1 from: the project's node_modules,
 * else toolsDir(), else the global npm root (each consulted only when the ones
 * before won't do). An
 * older TypeScript is simply not a candidate; one that should work but can't
 * (a broken install, a Node that can't load it) is reported as `unusable`.
 */
export function findTsgo(root: string): { dir: string } | { unusable: string } | null {
  const problems: string[] = [];
  const tryDir = (dir: string): string | null => {
    let version: string | null;
    try {
      version = packageVersion(dir);
    } catch (err) {
      problems.push(`can't read TypeScript at ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const [major = 0, minor = 0] = (version ?? '0').split('.').map(Number);
    if (major < TSGO_MIN[0]! || (major === TSGO_MIN[0] && minor < TSGO_MIN[1]!)) return null;
    if (!has(dir, 'dist/api/sync/api.js')) problems.push(`TypeScript ${version} at ${dir} has no API (dist/api/sync/api.js)`);
    // tsgo-index loads the (ES module) API with require().
    else if (!(process.features as { require_module?: boolean }).require_module) problems.push(`Node ${process.version} can't load TypeScript ${version}'s API (needs ≥ 20.19 / 22.12)`);
    else return dir;
    return null;
  };
  const local = tryDir(path.join(root, 'node_modules', 'typescript')) ?? tryDir(path.join(toolsDir(), 'node_modules', 'typescript'));
  if (local) return { dir: local };
  // No npm (or no global root) just means no global candidate.
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  const global = npmRoot.status === 0 && npmRoot.stdout.trim() ? tryDir(path.join(npmRoot.stdout.trim(), 'typescript')) : null;
  if (global) return { dir: global };
  return problems.length ? { unusable: problems.join('; ') } : null;
}

export const typescriptIndexer: IndexerSpec = {
  lang: 'typescript',
  tools: ['scip-typescript', 'tsgo-index'],
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
  patch: {
    'tsgo-index': {
      units: (_root, files) => files, // tsgo-index --only takes files
      seconds: (_root, files) => files.length * 0.1,
      runs([full], files, outFile) {
        if (!full) return null;
        const list = `${outFile}.only`;
        fs.writeFileSync(list, files.join('\n'));
        const args = [...full.args];
        args[2] = outFile;
        args.splice(4, 0, '--only', list); // after <tsDir> <output> <root>, before the configs
        return [{ label: 'typescript (tsgo, changed files)', args, output: outFile, env: full.env }];
      },
    },
    // A project at a time: each changed file's deepest tsconfig/jsconfig project, re-indexed whole.
    'scip-typescript': {
      units(root, files) {
        const byDepth = tsProjects(root).sort((a, b) => b.length - a.length);
        return [...new Set(files.map(f => byDepth.find(p => p === '.' || f.startsWith(`${p}/`)) ?? '.'))];
      },
      // A process start-up plus ~0.03 s a file (vscode: 361 s for 13.8k files), per project.
      seconds(root, projects) {
        const weights = projectWeights(tsProjects(root), repoFiles(root));
        return projects.reduce((s, p) => s + 3 + 0.03 * (weights.get(p) ?? 0), 0);
      },
      // The full plan's single-project runs (a batch's fallbacks are those), for the projects wanted.
      runs(full, projects, outFile) {
        if (full.length === 1 && !projects.includes(full[0]!.label)) return null; // one run for the whole repo: nothing smaller to run
        const single = full.flatMap(r => (r.fallback?.length ? r.fallback : [r]));
        const runs: IndexerRun[] = [];
        for (const p of projects) {
          const r = single.find(x => x.label === p);
          if (!r) return null;
          const output = `${outFile}.part${runs.length}`;
          runs.push({ ...r, args: r.args.map(a => (a === r.output ? output : a)), output, fallback: undefined });
        }
        return runs;
      },
    },
  },
  preferred(root, outFile) {
    const ts = findTsgo(root);
    if (!ts || 'unusable' in ts) return ts;
    const files = repoFiles(root);
    const projects = tsProjects(root, files);
    if (projects.length === 0 && !files.some(f => SOURCE.test(f))) return null; // no sources at all; with no tsconfig, tsgo-index infers one
    // Heaviest first; this only decides which project indexes a file its owner never loaded (see tsgo-index.ts).
    const weights = projectWeights(projects, files);
    const configs = [...projects].sort((a, b) => weights.get(b)! - weights.get(a)!)
      .map(p => path.posix.join(p, has(path.join(root, p), 'tsconfig.json') ? 'tsconfig.json' : 'jsconfig.json'));
    const referenceSites = `${outFile}.refs`;
    const args = [path.join(__dirname, 'tsgo-index.js'), ts.dir, outFile, root, '--refs', referenceSites, ...configs];
    return {
      cmd: process.execPath, tool: 'tsgo-index', runs: [{ label: 'typescript (tsgo)', args, output: outFile }],
      warning: missingDependencies(root), referenceSites,
    };
  },
};
