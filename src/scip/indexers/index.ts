/**
 * SCIP indexer adapters: which projects each covers, and the command that
 * produces its index. Optional overrides come from the `scip` block of the
 * project's `codegraph.json`:
 *
 *   "scip": {
 *     "typescript": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-typescript", "index", "--output", "{out}"] },
 *     "python": false
 *   }
 *
 * `false` disables a language; `cmd` / `args` / `env` replace the defaults.
 * `{out}` in args is the output path. Indexers are never auto-installed: a
 * command that isn't on PATH is reported and skipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_FILENAME } from '../../project-config';
import type { ScipLanguage } from '../store';
import { typescriptIndexer } from './typescript';

export interface IndexerSpec {
  lang: ScipLanguage;
  /** true when the project has this language's marker files */
  detect(projectRoot: string): boolean;
  cmd: string;
  args(projectRoot: string, outFile: string): string[];
  env?: Record<string, string>;
}

export interface IndexerOverride {
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export const INDEXERS: Partial<Record<ScipLanguage, IndexerSpec>> = {
  typescript: typescriptIndexer,
};

/** Tool name in an index's metadata → the language it covers (for `scip import`). */
export const TOOL_LANGUAGES: Record<string, ScipLanguage> = {
  'scip-typescript': 'typescript',
  'scip-python': 'python',
  'scip-go': 'go',
  'rust-analyzer': 'rust',
};

type ScipConfig = Partial<Record<ScipLanguage, IndexerOverride | false>>;

function readScipConfig(projectRoot: string): ScipConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, PROJECT_CONFIG_FILENAME), 'utf8')) as { scip?: unknown };
    return parsed.scip && typeof parsed.scip === 'object' ? (parsed.scip as ScipConfig) : {};
  } catch {
    return {};
  }
}

export interface ResolvedIndexer {
  lang: ScipLanguage;
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The indexer to run for `lang` in this project, or a reason it won't run.
 * Config overrides are validated here — a malformed entry is an error, not a silent default.
 */
export function resolveIndexer(projectRoot: string, lang: ScipLanguage, outFile: string): ResolvedIndexer | { skip: string } {
  const spec = INDEXERS[lang];
  if (!spec) return { skip: `no SCIP indexer adapter for ${lang} yet` };
  const override = readScipConfig(projectRoot)[lang];
  if (override === false) return { skip: `disabled in ${PROJECT_CONFIG_FILENAME}` };
  if (override !== undefined && (typeof override !== 'object' || override === null)) {
    return { skip: `${PROJECT_CONFIG_FILENAME} scip.${lang} must be false or an object` };
  }
  if (override?.args !== undefined && (!Array.isArray(override.args) || !override.args.every(a => typeof a === 'string'))) {
    return { skip: `${PROJECT_CONFIG_FILENAME} scip.${lang}.args must be an array of strings` };
  }
  if (!override && !spec.detect(projectRoot)) return { skip: `no ${lang} project markers found` };
  const cmd = override?.cmd ?? spec.cmd;
  const args = override?.args ? override.args.map(a => a.split('{out}').join(outFile)) : spec.args(projectRoot, outFile);
  if (!onPath(cmd)) return { skip: `\`${cmd}\` not found on PATH — install it or set scip.${lang}.cmd in ${PROJECT_CONFIG_FILENAME}` };
  return { lang, cmd, args, env: { ...spec.env, ...override?.env } };
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
