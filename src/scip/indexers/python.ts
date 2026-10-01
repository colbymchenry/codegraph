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

/**
 * Most files a Python patch re-indexes. Each directory among them is its own
 * scip-python run (it takes one `--target-only` path) costing ~10-20 s of
 * program setup, so past this a full run is about as fast.
 */
const PATCH_MAX_FILES = 8;

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
    if (!venv) {
      return {
        runs,
        warning: `no ${VENV_DIRS.join(' or ')} with pyvenv.cfg — indexing without third-party packages (calls into dependencies won't resolve)`,
      };
    }
    const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    return { runs, env: { VIRTUAL_ENV: venv, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
  },
  patch: {
    tools: ['scip-python'],
    maxFiles: PATCH_MAX_FILES,
    runs(full, files, outFile) {
      const at = full.args.indexOf('--output');
      if (at < 0) return null; // overridden args without an output we can redirect
      // A file passed as --target-only is left out of its own output (scip-python treats the
      // path as a directory prefix), so each changed file's directory is the target.
      const dirs = [...new Set(files.map(f => path.posix.dirname(f)))];
      return dirs.map((dir, i) => {
        const args = [...full.args];
        const output = `${outFile}.part${i}`;
        args[at + 1] = output;
        args.push('--target-only', dir);
        return { label: dir, args, output, light: true, env: full.env };
      });
    },
  },
};
