/**
 * scip-python (https://github.com/sourcegraph/scip-python) for Python.
 *
 * scip-python learns the installed packages by shelling out to `pip`, which a
 * uv-managed venv usually doesn't have. So the environment manifest is built
 * here instead, straight from the venv's `*.dist-info` records, and passed with
 * `--environment`. The venv is also activated (VIRTUAL_ENV + PATH) so pyright
 * resolves imports against its site-packages.
 *
 * Without a venv the manifest is empty: project code still resolves, calls into
 * third-party packages don't (they read as unknown/external, never as wrong).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IndexerSpec } from './index';

const MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
const VENV_DIRS = ['.venv', 'venv'];

/** How to create the venv, from what the project pins its dependencies with (first match). */
const VENV_SETUP: ReadonlyArray<readonly [string, string]> = [
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install (or activate its venv: VIRTUAL_ENV)'],
  ['requirements.txt', 'python -m venv .venv && .venv/bin/pip install -r requirements.txt'],
  ['pyproject.toml', 'python -m venv .venv && .venv/bin/pip install -e .'],
  ['setup.py', 'python -m venv .venv && .venv/bin/pip install -e .'],
];

/** The no-venv warning, with how to create one when the project says what it needs. */
function missingVenv(root: string): string {
  const setup = VENV_SETUP.find(([f]) => fs.existsSync(path.join(root, f)));
  return `no ${VENV_DIRS.join(' or ')} with pyvenv.cfg — indexing without third-party packages (calls into dependencies won't resolve)` +
    (setup ? `; ${setup[0]} found: run \`${setup[1]}\` and reindex` : '');
}

/** One entry of scip-python's `--environment` manifest (its `PythonPackage`). */
export interface PythonPackage {
  name: string;
  version: string;
  /** .py/.pyi paths relative to site-packages */
  files: string[];
}

/** A missing file is an answer (null); any other read failure is an error worth reporting. */
function readIfExists<T>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The project's own venv (`.venv/`, `venv/`), else the one active in the environment (`$VIRTUAL_ENV`). */
export function findVenv(root: string): string | null {
  const candidates = [...VENV_DIRS.map(d => path.join(root, d)), process.env.VIRTUAL_ENV].filter((d): d is string => !!d);
  return candidates.find(dir => fs.existsSync(path.join(dir, 'pyvenv.cfg'))) ?? null;
}

function sitePackages(venv: string): string[] {
  const win = path.join(venv, 'Lib', 'site-packages');
  if (fs.existsSync(win)) return [win];
  const lib = path.join(venv, 'lib');
  return (readIfExists(() => fs.readdirSync(lib)) ?? [])
    .filter(e => e.startsWith('python') || e.startsWith('pypy'))
    .map(e => path.join(lib, e, 'site-packages'))
    .filter(p => fs.existsSync(p));
}

function metadataField(metadata: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(metadata);
  return m ? m[1]!.trim() : null;
}

/** The installed distributions of a venv, as scip-python's `pip show -f` path would report them. */
export function venvPackages(venv: string): PythonPackage[] {
  const out: PythonPackage[] = [];
  for (const site of sitePackages(venv)) {
    for (const entry of fs.readdirSync(site)) {
      if (!entry.endsWith('.dist-info')) continue;
      const info = path.join(site, entry);
      const metadata = readIfExists(() => fs.readFileSync(path.join(info, 'METADATA'), 'utf8'));
      const record = readIfExists(() => fs.readFileSync(path.join(info, 'RECORD'), 'utf8'));
      if (metadata === null || record === null) continue; // incomplete install — nothing reliable to report
      const name = metadataField(metadata, 'Name');
      const version = metadataField(metadata, 'Version');
      if (!name || !version) continue;
      const files = record
        .split(/\r?\n/)
        .map(row => row.split(',')[0]!.trim())
        .filter(f => /\.pyi?$/.test(f) && !f.startsWith('..') && !f.includes('__pycache__'));
      out.push({ name, version, files });
    }
  }
  return out;
}

/** `[project]` / `[tool.poetry]` name from pyproject.toml, else setup.cfg's, else the directory name. */
export function projectName(root: string): string {
  const toml = readIfExists(() => fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'));
  const section = toml && /^\[(?:project|tool\.poetry)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml);
  const fromToml = section && /^name\s*=\s*["']([^"']+)["']/m.exec(section[1]!);
  if (fromToml) return fromToml[1]!;
  const cfg = readIfExists(() => fs.readFileSync(path.join(root, 'setup.cfg'), 'utf8'));
  const fromCfg = cfg && /^name\s*=\s*(\S+)/m.exec(cfg);
  if (fromCfg) return fromCfg[1]!;
  return path.basename(path.resolve(root));
}

export const pythonIndexer: IndexerSpec = {
  lang: 'python',
  tools: ['scip-python'],
  codegraphLanguages: ['python'],
  detect: root => MARKERS.some(m => fs.existsSync(path.join(root, m))),
  cmd: 'scip-python',
  invocation(root, outFile) {
    const venv = findVenv(root);
    const manifest = path.join(path.dirname(outFile), 'python-environment.json');
    fs.writeFileSync(manifest, JSON.stringify(venv ? venvPackages(venv) : []));
    const args = ['index', '.', '--project-name', projectName(root).replace(/\s+/g, '-'), '--environment', manifest, '--output', outFile];
    const runs = [{ label: 'python', args, output: outFile }];
    if (!venv) return { runs, warning: missingVenv(root) };
    const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    return { runs, env: { VIRTUAL_ENV: venv, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
  },
  patch: {
    'scip-python': {
      // A file passed as --target-only is left out of its own output (scip-python treats the
      // path as a directory prefix), so each changed file's directory is the target.
      units: (_root, files) => [...new Set(files.map(f => path.posix.dirname(f)))],
      // ~15 s a run (start-up and imports, measured on Django); light runs go side by side.
      seconds: (_root, dirs, width) => Math.ceil(dirs.length / width) * 15,
      runs([full], dirs, outFile) {
        const at = full?.args.indexOf('--output') ?? -1;
        if (!full || at < 0) return null; // overridden args without an output we can redirect
        return dirs.map((dir, i) => {
          const args = [...full.args];
          const output = `${outFile}.part${i}`;
          args[at + 1] = output;
          args.push('--target-only', dir);
          return { label: dir, args, output, light: true, env: full.env };
        });
      },
    },
  },
};
