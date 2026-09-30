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
import { goIndexer } from './go';
import { pythonIndexer } from './python';
import { rustIndexer } from './rust';
import { typescriptIndexer } from './typescript';

/** How to run an indexer for one project. */
export interface Invocation {
  args: string[];
  env?: Record<string, string>;
  /** something the user should know about the result's quality (shown, never fatal) */
  warning?: string;
}

export interface IndexerSpec {
  lang: ScipLanguage;
  /** true when the project has this language's marker files */
  detect(projectRoot: string): boolean;
  cmd: string;
  /**
   * Args for a cheap run that must succeed before the indexer counts as
   * installed — for commands that exist on PATH as shims even when the tool
   * behind them doesn't (rustup's `rust-analyzer` without the component).
   */
  probe?: string[];
  /** May write helper files next to `outFile` (e.g. an environment manifest). */
  invocation(projectRoot: string, outFile: string): Invocation;
}

export interface IndexerOverride {
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export const INDEXERS: Partial<Record<ScipLanguage, IndexerSpec>> = {
  typescript: typescriptIndexer,
  python: pythonIndexer,
  go: goIndexer,
  rust: rustIndexer,
};

/** Tool name in an index's metadata → the language it covers (for `scip import`). */
export const TOOL_LANGUAGES: Record<string, ScipLanguage> = {
  'scip-typescript': 'typescript',
  'scip-python': 'python',
  'scip-go': 'go',
  'rust-analyzer': 'rust',
};

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
  cmd: string;
  args: string[];
  env: Record<string, string>;
  warning?: string;
}

/**
 * The indexer to run for `lang` in this project, or a reason it won't run.
 * Config overrides are validated here — a malformed entry is an error, not a silent default.
 */
export function resolveIndexer(projectRoot: string, lang: ScipLanguage, outFile: string): ResolvedIndexer | { skip: string } {
  const spec = INDEXERS[lang];
  if (!spec) return { skip: `no SCIP indexer adapter for ${lang} yet` };
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
  const cmd = override?.cmd ?? spec.cmd;
  if (!onPath(cmd)) return { skip: `\`${cmd}\` not found on PATH — install it or set scip.${lang}.cmd in ${PROJECT_CONFIG_FILENAME}` };
  if (spec.probe && !override?.cmd) {
    const probe = spawnSync(cmd, spec.probe, { encoding: 'utf8', timeout: 20_000 });
    if (probe.status !== 0) {
      const why = (probe.error?.message ?? probe.stderr ?? '').trim().split('\n')[0];
      return { skip: `\`${cmd} ${spec.probe.join(' ')}\` failed (${why}) — the command is on PATH but not usable` };
    }
  }
  // The adapter's environment (e.g. an activated venv) applies even when the args are overridden.
  const inv = spec.invocation(projectRoot, outFile);
  const args = override?.args
    ? override.args.flatMap(a => (a === '{args}' ? inv.args : [a.split('{out}').join(outFile)]))
    : inv.args;
  return { lang, cmd, args, env: { ...inv.env, ...override?.env }, warning: inv.warning };
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
