/**
 * install.sh version-prune tests (issue #1074).
 *
 * The standalone installer keeps each release in its own `versions/<v>` dir and
 * — before this fix — never removed the old ones, so they piled up (~50 MB of
 * vendored Node runtime each) across upgrades. `install.sh` now prunes every
 * `versions/*` dir except the one it just installed.
 *
 * Rather than duplicate the shell (which would drift from the shipped script),
 * these tests extract the REAL prune block from `install.sh` — between its
 * `CODEGRAPH_PRUNE_OLD_VERSIONS` markers — and run it under `sh` against a temp
 * fixture, with `$INSTALL_DIR` / `$dest` injected. No network, no download.
 *
 * POSIX only: the block is `/bin/sh`. Windows installs overwrite a single dir in
 * place (install.ps1) and never reach this code, so there's nothing to prune.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SH = path.join(__dirname, '..', 'install.sh');
const START = '# >>> CODEGRAPH_PRUNE_OLD_VERSIONS';
const END = '# <<< CODEGRAPH_PRUNE_OLD_VERSIONS';

/** Pull the exact prune block out of the shipped install.sh (no duplication). */
function extractPruneBlock(): string {
  const lines = fs.readFileSync(INSTALL_SH, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.trim() === START);
  const j = lines.findIndex((l) => l.trim() === END);
  if (i < 0 || j < 0 || j <= i) {
    throw new Error('CODEGRAPH_PRUNE_OLD_VERSIONS markers not found in install.sh');
  }
  return lines.slice(i + 1, j).join('\n');
}

/** Single-quote a path for safe interpolation into the sh script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run the real prune block with INSTALL_DIR/dest set, return code + stdout. */
function runPrune(installDir: string, dest: string): { code: number; stdout: string } {
  const script = `set -eu\nINSTALL_DIR=${shq(installDir)}\ndest=${shq(dest)}\n${extractPruneBlock()}\n`;
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '' };
}

/** Create a versions/<v>/bin dir with a dummy launcher, like a real bundle. */
function seedVersion(installDir: string, version: string): string {
  const dir = path.join(installDir, 'versions', version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'codegraph'), '#!/bin/sh\n');
  return dir;
}

describe.skipIf(process.platform === 'win32')('install.sh version prune (#1074)', () => {
  let installDir: string;

  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prune-'));
  });
  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it('removes older version dirs and keeps only the just-installed one', () => {
    seedVersion(installDir, 'v1.1.2');
    seedVersion(installDir, 'v1.1.3');
    const dest = seedVersion(installDir, 'v1.1.4');
    fs.symlinkSync(dest, path.join(installDir, 'current'));

    const { code, stdout } = runPrune(installDir, dest);

    expect(code).toBe(0);
    const remaining = fs.readdirSync(path.join(installDir, 'versions')).sort();
    expect(remaining).toEqual(['v1.1.4']);
    expect(stdout).toContain('Removed    2 older version(s)');
    // The `current` symlink (outside versions/) is never globbed → untouched.
    expect(fs.existsSync(path.join(installDir, 'current'))).toBe(true);
    expect(fs.realpathSync(path.join(installDir, 'current'))).toBe(fs.realpathSync(dest));
  });

  it('is a silent no-op when the just-installed version is the only one', () => {
    const dest = seedVersion(installDir, 'v1.1.4');

    const { code, stdout } = runPrune(installDir, dest);

    expect(code).toBe(0);
    expect(fs.readdirSync(path.join(installDir, 'versions'))).toEqual(['v1.1.4']);
    expect(stdout).not.toContain('Removed');
  });

  it('does not error when there is no versions/ dir yet', () => {
    const dest = path.join(installDir, 'versions', 'v1.1.4'); // never created
    const { code, stdout } = runPrune(installDir, dest);
    expect(code).toBe(0);
    expect(stdout).not.toContain('Removed');
  });

  it('reports the count when several older versions are present', () => {
    for (const v of ['v1.0.0', 'v1.1.0', 'v1.1.1', 'v1.1.2', 'v1.1.3']) seedVersion(installDir, v);
    const dest = seedVersion(installDir, 'v1.1.4');

    const { code, stdout } = runPrune(installDir, dest);

    expect(code).toBe(0);
    expect(fs.readdirSync(path.join(installDir, 'versions'))).toEqual(['v1.1.4']);
    expect(stdout).toContain('Removed    5 older version(s)');
  });
});
