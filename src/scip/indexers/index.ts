/**
 * SCIP indexer adapters: which projects each covers, and the command that
 * produces its index. Optional overrides come from the `scip` block of the
 * project's `codegraph.json`:
 *
 *   "scip": {
 *     "typescript": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-typescript", "{args}"] },
 *     "python": false
 *   }
 *
 * `false` disables a language; `cmd` / `args` / `env` replace the defaults.
 * In args, an element `{args}` splices in the adapter's own arguments and
 * `{out}` is the output path. Indexers are never auto-installed: a command
 * that isn't on PATH is reported and skipped.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_FILENAME } from '../../project-config';
import type { ScipLanguage } from '../store';
import type { ImplHeader, LiteralShape } from '../syntax';
import { goIndexer } from './go';
import { pythonIndexer } from './python';
import { rustIndexer } from './rust';
import { typescriptIndexer } from './typescript';

/** One indexer process: its arguments and the file it writes. */
export interface IndexerRun {
  /** what this run covers, for logs and warnings (`src`, `extensions/git`, …) */
  label: string;
  args: string[];
  output: string;
  /** added to the invocation's env for this run (e.g. a smaller heap for a light batch) */
  env?: Record<string, string>;
  /** light enough to run alongside other light runs; heavy runs always run alone */
  light?: boolean;
  /** runs to try instead when this one fails (a batch retried one project at a time) */
  fallback?: IndexerRun[];
  /** repo-relative folder to run in (a module or workspace below the root); the root by default */
  cwd?: string;
}

/**
 * Prefix of a stderr line in which an indexer the fork ships (tsgo-index)
 * reports a part it skipped; a successful run's such lines become warnings.
 */
export const RUN_WARNING = 'codegraph-scip warning: ';

/**
 * How to index one project. Usually a single run; an adapter may split a large
 * repo into several — heavy parts alone, light parts batched and in parallel —
 * so peak memory is bounded by the largest part. The outputs are combined into
 * one index (see compact.ts).
 */
export interface Invocation {
  runs: IndexerRun[];
  /** the tool these runs write (`ToolInfo.name`); the adapter's first `tools` entry when unset */
  tool?: string;
  env?: Record<string, string>;
  /** something the user should know about the result's quality (shown, never fatal) */
  warning?: string;
  /**
   * A file the runs read codegraph's reference sites from (tsgo-index `--refs`), named
   * `${outFile}.*` like any helper file: produce.ts writes it before they run.
   */
  referenceSites?: string;
}

/** Everything the fork knows about one language — the single place to add or change one. */
export interface IndexerSpec {
  lang: ScipLanguage;
  /** `ToolInfo.name` in the indexes this language's indexers write (tells `scip import` the language) */
  tools: readonly string[];
  /** codegraph `files.language` values the index covers (the hash-gate snapshot) */
  codegraphLanguages: readonly string[];
  /** true when the project has this language's marker files */
  detect(projectRoot: string): boolean;
  cmd: string;
  /**
   * Args for a cheap run that must succeed before the indexer counts as
   * installed — for commands that exist on PATH as shims even when the tool
   * behind them doesn't (rustup's `rust-analyzer` without the component).
   */
  probe?: string[];
  /**
   * Runs writing `outFile` (or parts of it next to `outFile`). May write helper
   * files beside it too (e.g. an environment manifest).
   */
  invocation(projectRoot: string, outFile: string): Invocation;
  /**
   * A better indexer to run instead of `cmd` when it is installed; null when it
   * isn't, or why an installed one can't be used (then `cmd` runs, with that as
   * a warning). Consulted only when `cmd` and `args` aren't overridden.
   */
  preferred?(projectRoot: string, outFile: string): (Invocation & { cmd: string }) | { unusable: string } | null;
  /** for languages that construct values with `Type{…}` rather than a call */
  literalShape?: LiteralShape;
  /** An enum variant built like a call (Rust `Some(x)`) is a call to the variant — codegraph's view — not an instantiation. */
  variantCalls?: boolean;
  /**
   * A call that is a chain's own `.method()` line is keyed at the line the chain
   * starts on, where codegraph puts it (Rust, as rustfmt lays chains out).
   */
  chainCallsAtStart?: boolean;
  /** `impl Trait for Type` headers, judged as the type's `implements` edge (see syntax.ts ImplHeader) */
  implHeader?: ImplHeader;
  /**
   * Patching an installed index instead of rebuilding it (produce.ts patchIndex),
   * per tool that wrote it: its symbols must be named the same whatever else was
   * indexed, and its documents must define what they declare. The planner
   * (produce.ts incrementalPlan) patches when `seconds` is under half the last
   * full run's time.
   */
  patch?: Partial<Record<string, PatchSpec>>;
}

export interface PatchSpec {
  /** the smallest pieces a run re-indexes that cover `files`: a file, its directory, its package, its project */
  units(projectRoot: string, files: string[]): string[];
  /** rough seconds to re-index `units`, given how many light runs go side by side */
  seconds(projectRoot: string, units: string[], width: number): number;
  /**
   * The runs re-indexing `units`, derived from the resolved full runs; they may
   * write helper files named `${outFile}.*`. Null → only a full run will do.
   */
  runs(full: readonly IndexerRun[], units: string[], outFile: string): IndexerRun[] | null;
}

export interface IndexerOverride {
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export const INDEXERS: Record<ScipLanguage, IndexerSpec> = {
  typescript: typescriptIndexer,
  python: pythonIndexer,
  go: goIndexer,
  rust: rustIndexer,
};

/** The language an index covers, from the tool that wrote it. */
export function languageOfTool(tool: string): ScipLanguage | undefined {
  return Object.values(INDEXERS).find(s => s.tools.includes(tool))?.lang;
}

type ScipConfig = Partial<Record<ScipLanguage, IndexerOverride | false>>;

/** The `scip` block, or an error string. No config file at all means no overrides. */
function readScipConfig(projectRoot: string): ScipConfig | string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectRoot, PROJECT_CONFIG_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return `can't read ${PROJECT_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `${PROJECT_CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const scip = (parsed as { scip?: unknown } | null)?.scip;
  if (scip === undefined) return {};
  if (typeof scip !== 'object' || scip === null || Array.isArray(scip)) return `${PROJECT_CONFIG_FILENAME} "scip" must be an object`;
  return scip as ScipConfig;
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');

export interface ResolvedIndexer {
  lang: ScipLanguage;
  /** the tool its runs write (see Invocation.tool) */
  tool: string;
  cmd: string;
  runs: IndexerRun[];
  env: Record<string, string>;
  warning?: string;
  referenceSites?: string;
}

/**
 * The indexer to run for `lang` in this project, or a reason it won't run.
 * Config overrides are validated here — a malformed entry is an error, not a silent default.
 */
export function resolveIndexer(projectRoot: string, lang: ScipLanguage, outFile: string): ResolvedIndexer | { skip: string } {
  const spec = INDEXERS[lang];
  const config = readScipConfig(projectRoot);
  if (typeof config === 'string') return { skip: config };
  const override = config[lang];
  const at = `${PROJECT_CONFIG_FILENAME} scip.${lang}`;
  if (override === false) return { skip: `disabled in ${PROJECT_CONFIG_FILENAME}` };
  if (override !== undefined && (typeof override !== 'object' || override === null || Array.isArray(override))) {
    return { skip: `${at} must be false or an object` };
  }
  if (override?.cmd !== undefined && (typeof override.cmd !== 'string' || override.cmd === '')) {
    return { skip: `${at}.cmd must be a non-empty string` };
  }
  if (override?.args !== undefined && (!Array.isArray(override.args) || !override.args.every(a => typeof a === 'string'))) {
    return { skip: `${at}.args must be an array of strings` };
  }
  if (override?.env !== undefined && !isStringRecord(override.env)) {
    return { skip: `${at}.env must be an object of string values` };
  }
  if (!spec.detect(projectRoot)) return { skip: `no ${lang} project markers found` };
  const preferred = override?.cmd || override?.args ? null : spec.preferred?.(projectRoot, outFile);
  if (preferred && 'runs' in preferred) {
    return {
      lang, tool: preferred.tool ?? spec.tools[0]!, cmd: preferred.cmd, runs: preferred.runs,
      env: { ...preferred.env, ...override?.env }, warning: preferred.warning, referenceSites: preferred.referenceSites,
    };
  }
  const unusable = preferred?.unusable;
  const cmd = override?.cmd ?? spec.cmd;
  if (!onPath(cmd)) {
    return { skip: `\`${cmd}\` not found on PATH — install it or set scip.${lang}.cmd in ${PROJECT_CONFIG_FILENAME}${unusable ? ` (${unusable})` : ''}` };
  }
  if (spec.probe && !override?.cmd) {
    const probe = spawnSync(cmd, spec.probe, { encoding: 'utf8', timeout: 20_000 });
    if (probe.status !== 0) {
      const why = (probe.error?.message ?? probe.stderr ?? '').trim().split('\n')[0];
      return { skip: `\`${cmd} ${spec.probe.join(' ')}\` failed (${why}) — the command is on PATH but not usable` };
    }
  }
  // The adapter's environment (e.g. an activated venv) and its split into runs
  // apply even when the args are overridden: `{args}` / `{out}` are per run.
  const inv = spec.invocation(projectRoot, outFile);
  const apply = (run: IndexerRun): IndexerRun => ({
    ...run,
    args: override?.args
      ? override.args.flatMap(a => (a === '{args}' ? run.args : [a.split('{out}').join(run.output)]))
      : run.args,
    env: run.env && { ...run.env, ...override?.env }, // the user's env wins over the adapter's per-run env
    fallback: run.fallback?.map(apply),
  });
  const warning = [inv.warning, unusable && `${unusable} — using ${cmd}`].filter(Boolean).join('; ') || undefined;
  return {
    lang, tool: inv.tool ?? spec.tools[0]!, cmd, runs: inv.runs.map(apply), env: { ...inv.env, ...override?.env }, warning,
    referenceSites: inv.referenceSites,
  };
}

export function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const isExec = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/') || cmd.includes('\\')) return isExec(cmd);
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && exts.some(e => isExec(path.join(dir, cmd + e))));
}
