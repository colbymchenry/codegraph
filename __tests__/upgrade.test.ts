import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectInstallMethod,
  deriveInstallDir,
  parseSemver,
  compareVersions,
  isUpdateAvailable,
  normalizeVersion,
  stripV,
  parseLatestTagFromLocation,
  reindexAdvisory,
  runUpgrade,
  buildWindowsUpgradeScript,
  NPM_PACKAGE,
  type InstallMethod,
  type UpgradeDeps,
} from '../src/upgrade';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { CodeGraph } from '../src';

// ---------------------------------------------------------------------------
// detectInstallMethod — structural detection from the running file's path
// ---------------------------------------------------------------------------

describe('detectInstallMethod', () => {
  // A bundle exists if a vendored node + launcher sit next to lib/.
  function bundleExists(present: Set<string>) {
    return (p: string) => present.has(p.replace(/\\/g, '/'));
  }

  it('detects a unix bundle and derives the install dir from the versions/ layout', () => {
    const root = '/home/u/.codegraph/versions/v0.9.9';
    const filename = `${root}/lib/dist/bin/codegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/codegraph`, '/home/u/.codegraph']);
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: bundleExists(present),
    });
    expect(m).toEqual({
      kind: 'bundle',
      os: 'unix',
      bundleRoot: root,
      installDir: '/home/u/.codegraph',
    });
  });

  it('detects a windows bundle and derives the install dir from current\\', () => {
    const root = 'C:/Users/u/AppData/Local/codegraph/current';
    const filename = `${root}/lib/dist/bin/codegraph.js`;
    const present = new Set([`${root}/node.exe`, `${root}/bin/codegraph.cmd`]);
    const m = detectInstallMethod({
      filename,
      platform: 'win32',
      cwd: 'C:/Users/u/project',
      exists: bundleExists(present),
    }) as Extract<InstallMethod, { kind: 'bundle' }>;
    expect(m.kind).toBe('bundle');
    expect(m.os).toBe('windows');
    // win32 path math emits backslashes; compare separator-independently.
    expect(m.installDir?.replace(/\\/g, '/')).toBe('C:/Users/u/AppData/Local/codegraph');
  });

  it('detects a global npm install', () => {
    const filename = '/usr/local/lib/node_modules/@colbymchenry/codegraph/dist/bin/codegraph.js';
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: () => false,
    });
    expect(m).toEqual({ kind: 'npm', scope: 'global' });
  });

  it('detects a local (project) npm install as local', () => {
    const cwd = '/home/u/project';
    const filename = `${cwd}/node_modules/@colbymchenry/codegraph/dist/bin/codegraph.js`;
    const m = detectInstallMethod({ filename, platform: 'linux', cwd, exists: () => false });
    expect(m).toEqual({ kind: 'npm', scope: 'local' });
  });

  it('detects an npx run from the _npx cache', () => {
    const filename = '/home/u/.npm/_npx/abc123/node_modules/@colbymchenry/codegraph/dist/bin/codegraph.js';
    const m = detectInstallMethod({ filename, platform: 'linux', cwd: '/home/u', exists: () => false });
    expect(m).toEqual({ kind: 'npx' });
  });

  it('detects a source checkout via sibling package.json + .git', () => {
    const repo = '/home/u/dev/codegraph';
    const filename = `${repo}/dist/bin/codegraph.js`;
    const present = new Set([`${repo}/package.json`, `${repo}/.git`]);
    const m = detectInstallMethod({
      filename,
      platform: 'darwin',
      cwd: repo,
      exists: bundleExists(present),
    });
    expect(m).toEqual({ kind: 'source', root: repo });
  });

  it('returns unknown for an unrecognized layout', () => {
    const m = detectInstallMethod({
      filename: '/opt/weird/place/codegraph.js',
      platform: 'linux',
      cwd: '/tmp',
      exists: () => false,
    });
    expect(m.kind).toBe('unknown');
  });
});

describe('deriveInstallDir', () => {
  it('unix: returns the dir above versions/', () => {
    expect(deriveInstallDir('/a/b/.codegraph/versions/v1.2.3', 'unix', () => true)).toBe('/a/b/.codegraph');
  });
  it('unix: null when not under versions/', () => {
    expect(deriveInstallDir('/a/b/somewhere', 'unix', () => true)).toBeNull();
  });
  it('windows: returns the parent of current\\', () => {
    expect(deriveInstallDir('C:/x/codegraph/current', 'windows', () => true)?.replace(/\\/g, '/')).toBe('C:/x/codegraph');
  });
  it('windows: null when basename is not current', () => {
    expect(deriveInstallDir('C:/x/codegraph/v1', 'windows', () => true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// version helpers
// ---------------------------------------------------------------------------

describe('version helpers', () => {
  it('parseSemver handles v-prefix and prerelease', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'rc.1' });
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compareVersions orders correctly incl. prerelease < release', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('isUpdateAvailable compares, and falls back to string-inequality for unparseable', () => {
    expect(isUpdateAvailable('0.9.8', '0.9.9')).toBe(true);
    expect(isUpdateAvailable('0.9.9', '0.9.9')).toBe(false);
    expect(isUpdateAvailable('0.9.9', '0.9.8')).toBe(false);
    // dev sentinel can't parse → any difference means "update available"
    expect(isUpdateAvailable('0.0.0-unknown', '0.9.9')).toBe(true);
  });

  it('normalizeVersion / stripV round-trip', () => {
    expect(normalizeVersion('0.9.9')).toBe('v0.9.9');
    expect(normalizeVersion('v0.9.9')).toBe('v0.9.9');
    expect(stripV('v0.9.9')).toBe('0.9.9');
    expect(stripV('0.9.9')).toBe('0.9.9');
  });

  it('parseLatestTagFromLocation extracts the tag from a releases redirect', () => {
    expect(parseLatestTagFromLocation('https://github.com/colbymchenry/codegraph/releases/tag/v0.9.9')).toBe('v0.9.9');
    expect(parseLatestTagFromLocation('https://github.com/o/r/releases/tag/v1.2.3?foo=bar')).toBe('v1.2.3');
    expect(parseLatestTagFromLocation(undefined)).toBeNull();
    expect(parseLatestTagFromLocation('https://github.com/o/r/releases')).toBeNull();
  });

  it('reindexAdvisory mentions the refresh commands', () => {
    const a = reindexAdvisory();
    expect(a).toContain('codegraph sync');
    expect(a).toContain('codegraph index -f');
  });

  it('buildWindowsUpgradeScript targets the right asset per arch and renames-not-deletes the exe', () => {
    const arm = buildWindowsUpgradeScript('C:\\cg\\current', 'v1.2.3', 'arm64');
    expect(arm).toContain('releases/download/v1.2.3/codegraph-win32-arm64.zip');
    expect(arm).toContain("$dest='C:\\cg\\current'");
    expect(arm).toContain('Rename-Item'); // never Remove-Item on the locked exe
    expect(arm).not.toMatch(/Remove-Item[^;]*\$dest'?\s*;/); // doesn't delete current\
    const x64 = buildWindowsUpgradeScript('C:\\cg\\current', 'v1.2.3', 'x64');
    expect(x64).toContain('codegraph-win32-x64.zip');
  });
});

// ---------------------------------------------------------------------------
// runUpgrade orchestration — mocked side-effects
// ---------------------------------------------------------------------------

interface Calls {
  runs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>;
  logs: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<UpgradeDeps> & { method: InstallMethod; currentVersion: string },
  runExit = 0
): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { runs: [], logs: [], errors: [] };
  const deps: UpgradeDeps = {
    currentVersion: overrides.currentVersion,
    method: overrides.method,
    resolveLatest: overrides.resolveLatest ?? (async () => 'v0.9.9'),
    run: (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      return runExit;
    },
    hasCommand: overrides.hasCommand ?? ((c) => c === 'curl'),
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.logs.push(m),
    error: (m) => calls.errors.push(m),
    platform: overrides.platform ?? 'linux',
  };
  return { deps, calls };
}

/** Decode a `-EncodedCommand` base64 (UTF-16LE) payload back to its script. */
function decodeEncodedCommand(args: string[]): string {
  const i = args.indexOf('-EncodedCommand');
  if (i < 0) throw new Error('no -EncodedCommand in args');
  return Buffer.from(args[i + 1]!, 'base64').toString('utf16le');
}

describe('runUpgrade', () => {
  it('does nothing when already up to date', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.9' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/up to date/i);
  });

  it('--check reports an available update without running anything', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({ check: true }, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/update is available/i);
  });

  it('unix bundle: runs the installer via sh with the derived install dir', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'bundle', os: 'unix', bundleRoot: '/h/.codegraph/versions/v0.9.8', installDir: '/h/.codegraph' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].cmd).toBe('sh');
    expect(calls.runs[0].args[0]).toBe('-c');
    expect(calls.runs[0].args[1]).toContain('curl -fsSL');
    expect(calls.runs[0].args[1]).toContain('| sh');
    expect(calls.runs[0].env?.CODEGRAPH_INSTALL_DIR).toBe('/h/.codegraph');
    expect(calls.logs.join('\n')).toMatch(/codegraph sync/); // re-index advisory printed
  });

  it('unix bundle: falls back to wget, and errors when neither downloader exists', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'bundle', os: 'unix', bundleRoot: '/h/.codegraph/versions/v0.9.8', installDir: null },
      currentVersion: '0.9.8',
      hasCommand: () => false,
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs).toHaveLength(0);
    expect(calls.errors.join('\n')).toMatch(/curl nor wget/i);
  });

  it('windows bundle: runs a synchronous in-place (rename + extract) powershell upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/codegraph/current', installDir: 'C:/x/codegraph' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].cmd).toBe('powershell.exe');
    const decoded = decodeEncodedCommand(calls.runs[0].args);
    // Downloads the right asset, renames the locked exe aside, copies over current\.
    expect(decoded).toContain('releases/download/v0.9.9/codegraph-win32-');
    expect(decoded).toContain('Rename-Item');
    expect(decoded).toContain('node.exe.old-');
    expect(decoded).toContain('Copy-Item');
  });

  it('windows bundle: a non-zero installer exit is a failure', async () => {
    const { deps, calls } = makeDeps(
      {
        method: { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/codegraph/current', installDir: 'C:/x/codegraph' },
        currentVersion: '0.9.8',
        platform: 'win32',
      },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/exited with code/i);
  });

  it('npm global: shells out to npm install -g @pkg@latest', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs[0].cmd).toBe('npm');
    expect(calls.runs[0].args).toEqual(['install', '-g', `${NPM_PACKAGE}@latest`]);
  });

  it('npm on win32 uses npm.cmd', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    await runUpgrade({}, deps);
    expect(calls.runs[0].cmd).toBe('npm.cmd');
  });

  it('npm: a pinned version is passed through as @<version>', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.9',
    });
    await runUpgrade({ version: '0.9.8' }, deps);
    // npm spec carries no leading "v".
    expect(calls.runs[0].args).toEqual(['install', '-g', `${NPM_PACKAGE}@0.9.8`]);
  });

  it('npm: surfaces a non-zero exit as failure', async () => {
    const { deps, calls } = makeDeps(
      { method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/npm exited/i);
  });

  it('npx: nothing to upgrade', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npx' }, currentVersion: '0.9.8' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/nothing to upgrade/i);
  });

  it('source: tells the user to git pull, runs nothing', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'source', root: '/dev/codegraph' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/git pull/);
  });
});

// ---------------------------------------------------------------------------
// Re-index staleness — real index, real metadata stamp
// ---------------------------------------------------------------------------

describe('index extraction-version stamp / isIndexStale', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-stamp-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the current extraction version on full index and is not stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await CodeGraph.init(dir, { index: false });
    // No index yet → not stale (nothing to refresh).
    expect(cg.isIndexStale()).toBe(false);

    await cg.indexAll();
    const info = cg.getIndexBuildInfo();
    expect(info.extractionVersion).toBe(EXTRACTION_VERSION);
    expect(typeof info.version).toBe('string');
    expect(cg.isIndexStale()).toBe(false);
    cg.destroy();
  });

  it('flags an index stamped by an older extraction version as stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();

    // Simulate an index built by an older engine.
    (cg as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries.setMetadata(
      'indexed_with_extraction_version',
      String(EXTRACTION_VERSION - 1)
    );
    expect(cg.isIndexStale()).toBe(true);
    cg.destroy();
  });
});
