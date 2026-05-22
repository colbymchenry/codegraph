/**
 * Regression test for scripts/npm-shim.js.
 *
 * Background: Node's CVE-2024-27980 mitigation forbids spawning .cmd/.bat
 * launchers without `shell: true`. The shim previously resolved the platform
 * package's `bin/codegraph.cmd` and called spawnSync on it, which returned
 * EINVAL on Windows before any CLI logic ran.
 *
 * This test stands up a minimal platform-package fixture (the bundled
 * node binary + lib/dist/bin/codegraph.js + the legacy wrapper launcher)
 * and verifies the shim launches it cleanly with arguments forwarded.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SHIM = path.resolve(__dirname, '..', 'scripts', 'npm-shim.js');

function makeFixture(): { tmp: string; shim: string } {
  const target = `${process.platform}-${process.arch}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shim-'));
  const pkgRoot = path.join(tmp, 'node_modules', '@colbymchenry', `codegraph-${target}`);
  fs.mkdirSync(path.join(pkgRoot, 'lib', 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });

  // Bundled Node binary — reuse the current process's node so the fixture is
  // a real, executable binary at the expected path.
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(pkgRoot, nodeName));
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(pkgRoot, nodeName), 0o755);
  }

  // The script the bundled node should run.
  fs.writeFileSync(
    path.join(pkgRoot, 'lib', 'dist', 'bin', 'codegraph.js'),
    "process.stdout.write('SHIM_OK:' + JSON.stringify(process.argv.slice(2)));"
  );

  // Legacy wrappers — kept so the *unfixed* shim can still find them and
  // exhibit the EINVAL regression rather than failing earlier at resolution.
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(pkgRoot, 'bin', 'codegraph.cmd'),
      '@"%~dp0..\\node.exe" "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\n'
    );
  } else {
    const sh = path.join(pkgRoot, 'bin', 'codegraph');
    fs.writeFileSync(sh, '#!/bin/sh\nexec "$(dirname "$0")/../node" "$(dirname "$0")/../lib/dist/bin/codegraph.js" "$@"\n');
    fs.chmodSync(sh, 0o755);
  }

  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: `@colbymchenry/codegraph-${target}`, version: '0.0.0' })
  );

  // Copy the shim into the fixture root so require.resolve walks the
  // fixture's node_modules tree, finding our fake platform package.
  const shim = path.join(tmp, 'npm-shim.js');
  fs.copyFileSync(SHIM, shim);

  return { tmp, shim };
}

describe('npm-shim launcher', () => {
  it('launches the bundled node and forwards arguments without invoking the .cmd/.sh wrapper', () => {
    const { tmp, shim } = makeFixture();
    try {
      const res = spawnSync(process.execPath, [shim, 'install', '--target=hermes', '--yes'], {
        encoding: 'utf8',
        cwd: tmp,
      });

      // The actual regression: on Windows, spawnSync on .cmd without
      // shell:true returns EINVAL inside the shim. The shim catches it and
      // exits 1 after printing the spawn error to stderr. A clean launch
      // exits 0 with the inner script's stdout intact.
      expect(res.stderr).not.toMatch(/EINVAL/);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('SHIM_OK:["install","--target=hermes","--yes"]');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
