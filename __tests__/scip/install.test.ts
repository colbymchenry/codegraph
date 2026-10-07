/**
 * install.sh with CODEGRAPH_ARCHIVE: the fork installs its own bundle through
 * upstream's installer (link + prune older versions), no download.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SH = path.join(__dirname, '..', '..', 'install.sh');

describe.runIf(process.platform !== 'win32')('install.sh CODEGRAPH_ARCHIVE', () => {
  let dir: string;
  let archive: string;
  const install = (env: Record<string, string>) => spawnSync('sh', [INSTALL_SH], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH!, HOME: dir,
      CODEGRAPH_INSTALL_DIR: path.join(dir, 'home'), CODEGRAPH_BIN_DIR: path.join(dir, 'bin'), ...env,
    },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-'));
    const stage = path.join(dir, 'stage', 'codegraph-linux-x64', 'bin');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'codegraph'), '#!/bin/sh\necho fork-bundle\n', { mode: 0o755 });
    archive = path.join(dir, 'codegraph-linux-x64.tar.gz');
    spawnSync('tar', ['-czf', archive, '-C', path.join(dir, 'stage'), 'codegraph-linux-x64']);
    fs.mkdirSync(path.join(dir, 'home', 'versions', 'v1.0.0-scip.old'), { recursive: true });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('installs the local archive, links it, and prunes older versions', () => {
    const r = install({ CODEGRAPH_ARCHIVE: archive, CODEGRAPH_VERSION: 'v1.6.1-scip.abc1234' });
    expect(r.status, r.stderr).toBe(0);
    const dest = path.join(dir, 'home', 'versions', 'v1.6.1-scip.abc1234');
    expect(fs.readdirSync(path.join(dir, 'home', 'versions'))).toEqual(['v1.6.1-scip.abc1234']);
    expect(fs.readlinkSync(path.join(dir, 'home', 'current'))).toBe(dest);
    expect(spawnSync(path.join(dir, 'bin', 'codegraph'), { encoding: 'utf8' }).stdout).toBe('fork-bundle\n');
  });

  it('refuses an archive without a version to name it', () => {
    const r = install({ CODEGRAPH_ARCHIVE: archive });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CODEGRAPH_ARCHIVE needs CODEGRAPH_VERSION/);
  });
});
