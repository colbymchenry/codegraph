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
  verifyResolvedVersion,
  defaultWirePromptHook,
  buildWindowsUpgradeScript,
  WINDOWS_SWAP_FUNCTION,
  WINDOWS_UPGRADE_DAMAGED,
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

  // The npm thin-installer's per-platform package IS a complete bundle
  // (vendored node + bin/ launcher) sitting inside node_modules. The layout
  // sniff must not win over the node_modules path check, or `upgrade` curls
  // install.sh into ~/.codegraph — a second install that loses the PATH race
  // to npm's shim, so `codegraph -v` stays on the old version forever.
  it('detects the npm thin-installer platform package as npm, not bundle', () => {
    const root = '/usr/local/lib/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-linux-x64';
    const filename = `${root}/lib/dist/bin/codegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/codegraph`]);
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: bundleExists(present),
    });
    expect(m).toEqual({ kind: 'npm', scope: 'global' });
  });

  it('detects a project-local thin-installer platform package as npm local', () => {
    const cwd = '/home/u/project';
    const root = `${cwd}/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-darwin-arm64`;
    const filename = `${root}/lib/dist/bin/codegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/codegraph`]);
    const m = detectInstallMethod({ filename, platform: 'darwin', cwd, exists: bundleExists(present) });
    expect(m).toEqual({ kind: 'npm', scope: 'local' });
  });

  it('still detects an npx run when the cached platform package has the bundle layout', () => {
    const root = '/home/u/.npm/_npx/abc123/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-linux-x64';
    const filename = `${root}/lib/dist/bin/codegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/codegraph`]);
    const m = detectInstallMethod({ filename, platform: 'linux', cwd: '/home/u', exists: bundleExists(present) });
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

  it('buildWindowsUpgradeScript targets the right asset per arch', () => {
    const arm = buildWindowsUpgradeScript('C:\\cg\\current', 'v1.2.3', 'arm64');
    expect(arm).toContain('releases/download/v1.2.3/codegraph-win32-arm64.zip');
    expect(arm).toContain("$dest='C:\\cg\\current'");
    expect(arm).toContain("Join-Path $stage 'codegraph-win32-arm64'");
    const x64 = buildWindowsUpgradeScript('C:\\cg\\current', 'v1.2.3', 'x64');
    expect(x64).toContain('codegraph-win32-x64.zip');
  });
});

// ---------------------------------------------------------------------------
// Windows file swap (#2185) — a running CodeGraph process (an agent session's
// MCP server) keeps node.exe and the native kernel locked: they can be renamed
// but not overwritten or deleted. The upgrade used to rename only node.exe and
// then Copy-Item over the rest, so the locked kernel failed the copy halfway
// and left the install with no node.exe. PowerShell can't run on the macOS
// test host, so these pin the script's shape; the behavior is validated on a
// real Windows machine.
// ---------------------------------------------------------------------------

describe('windows bundle swap script (#2185)', () => {
  const INSTALL_PS1 = path.join(__dirname, '..', 'install.ps1');
  const installPs1 = () => fs.readFileSync(INSTALL_PS1, 'utf-8').replace(/\r\n/g, '\n');
  const script = () => buildWindowsUpgradeScript('C:\\Users\\me\\AppData\\Local\\codegraph\\current', 'v1.6.2', 'x64');
  /** The swap function's own statements, comments dropped. */
  const swapCode = () => WINDOWS_SWAP_FUNCTION.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('install.ps1 carries the same swap function, verbatim', () => {
    const m = /# >>> Install-CodeGraphFiles[^\n]*\n([\s\S]*?)# <<< Install-CodeGraphFiles/.exec(installPs1());
    expect(m, 'install.ps1 lost its Install-CodeGraphFiles markers').not.toBeNull();
    expect(m![1]).toBe(WINDOWS_SWAP_FUNCTION);
  });

  it('never copies over or deletes current\\ in place', () => {
    for (const text of [script(), installPs1()]) {
      expect(text).not.toMatch(/Copy-Item/);
      expect(text).not.toMatch(/Remove-Item[^\n]*\$dest\b/);
      expect(text).not.toMatch(/Expand-Archive[^\n]*\$dest\b/);
    }
  });

  it('unpacks next to current\\ (same volume), not into %TEMP%, then swaps', () => {
    const s = script();
    expect(s).toContain(`$stage=Join-Path (Split-Path -Parent $dest) ('.staging-'`);
    expect(s).toMatch(/Expand-Archive -Path \$zip -DestinationPath \$stage/);
    expect(s.indexOf('Expand-Archive')).toBeLessThan(s.indexOf('Install-CodeGraphFiles $('));
    // install.ps1 stages next to current\ too.
    expect(installPs1()).toContain(`$stage = Join-Path $installDir ('.staging-'`);
    expect(installPs1()).toMatch(/Install-CodeGraphFiles \$\(.*\) \$dest$/m);
  });

  it('renames every replaced file aside before moving the staged file in', () => {
    const code = swapCode();
    // Replaced files and files the new version drops are both renamed aside…
    expect(code.match(/Move-Logged \$at "\$at\.old-\$token"/g)).toHaveLength(2);
    // …and the aside-rename of a target comes before the staged file moves in.
    const aside = code.indexOf('if ([IO.File]::Exists($at)) { Move-Logged $at "$at.old-$token" }');
    const moveIn = code.indexOf('Move-Logged ($stageDir + $rel) $at');
    expect(aside).toBeGreaterThan(0);
    expect(moveIn).toBeGreaterThan(aside);
    // No in-place overwrite or delete of a live file during the swap.
    expect(code).not.toMatch(/\[IO\.File\]::(Copy|Replace)\(/);
    expect(code).not.toMatch(/Move-Item|Rename-Item/);
  });

  it('rolls back on failure and on interruption, and says whether the install still works', () => {
    const code = swapCode();
    expect(code).toMatch(/catch \{[\s\S]*\$lost = Undo-Logged[\s\S]*\} finally \{\s*if \(-not \$done\) \{ \[void\]\(Undo-Logged\) \}/);
    // Undo walks the log backwards, moving each file back to where it was.
    expect(code).toContain('for ($n = $undo.Count - 1; $n -ge 0; $n--)');
    expect(code).toContain('[IO.File]::Move($u[1], $u[0])');
    expect(code).toContain('Nothing was changed: the existing install still works.');
    expect(code).toContain("$e.Data['codegraphDamaged'] = [bool]$lost");
    // The upgrade script maps that flag to the exit code runUpgrade reads.
    expect(script()).toContain(`$code=if($_.Exception.Data['codegraphDamaged']){${WINDOWS_UPGRADE_DAMAGED}}else{1}`);
    expect(script().trimEnd().endsWith('exit $code')).toBe(true);
  });

  it('refuses a download that is not a bundle before touching current\\', () => {
    const code = swapCode();
    expect(code).toContain("foreach ($need in 'node.exe', 'bin\\codegraph.cmd')");
    expect(code.indexOf("foreach ($need in")).toBeLessThan(code.indexOf('try {'));
  });

  it('cleans up renamed-aside leftovers, including ones from earlier upgrades', () => {
    const m = /\$asideName = '([^']+)'/.exec(WINDOWS_SWAP_FUNCTION);
    expect(m).not.toBeNull();
    const aside = new RegExp(m![1]!, 'i'); // PowerShell -match is case-insensitive
    // The pre-fix upgrade left node.exe.old-<32-hex guid>; this one uses 8 hex.
    expect(aside.test('node.exe.old-0123456789abcdef0123456789ABCDEF')).toBe(true);
    expect(aside.test('codegraph-kernel.node.old-deadbeef')).toBe(true);
    for (const shipped of ['node.exe', 'codegraph-kernel.node', 'old-deadbeef.js', 'x.old-1234567', 'a.old-deadbeef.js']) {
      expect(aside.test(shipped), shipped).toBe(false);
    }
    // No file a bundle actually ships looks like a leftover.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]));
    const distDir = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(distDir)) expect(walk(distDir).filter((n) => aside.test(n))).toEqual([]);
    // Deleted only after a successful swap, and a still-locked one is skipped.
    const code = swapCode();
    expect(code.indexOf('[IO.File]::Delete($f.FullName)')).toBeGreaterThan(code.indexOf('$done = $true'));
    expect(code).toContain('try { [IO.File]::Delete($f.FullName) } catch {}');
  });

  it('quotes the install path for PowerShell', () => {
    const s = buildWindowsUpgradeScript("C:\\Users\\o'brien\\codegraph\\current", 'v1.6.2', 'x64');
    expect(s).toContain("$dest='C:\\Users\\o''brien\\codegraph\\current'");
  });

  it('fits a Windows command line even for a long install path', () => {
    const root = `C:\\${'very-long-directory-name\\'.repeat(8)}codegraph\\current`;
    const encoded = Buffer.from(buildWindowsUpgradeScript(root, 'v10.20.30', 'arm64'), 'utf16le').toString('base64');
    // CreateProcess caps the whole command line at 32,767 characters.
    expect(encoded.length).toBeLessThan(24_000);
  });
});

// ---------------------------------------------------------------------------
// runUpgrade orchestration — mocked side-effects
// ---------------------------------------------------------------------------

interface Calls {
  runs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>;
  captures: Array<{ cmd: string; args: string[] }>;
  logs: string[];
  errors: string[];
  /** How many times the upgrade asked deps to wire the Claude prompt hook. */
  promptHookWires: number;
}

function makeDeps(
  overrides: Partial<UpgradeDeps> & { method: InstallMethod; currentVersion: string },
  runExit = 0
): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { runs: [], captures: [], logs: [], errors: [], promptHookWires: 0 };
  const deps: UpgradeDeps = {
    currentVersion: overrides.currentVersion,
    method: overrides.method,
    resolveLatest: overrides.resolveLatest ?? (async () => 'v0.9.9'),
    run: (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      return runExit;
    },
    // Default probe: spawn fails → 'inconclusive'. Tests that exercise the
    // post-upgrade version check override this.
    capture: (cmd, args) => {
      calls.captures.push({ cmd, args });
      return overrides.capture ? overrides.capture(cmd, args) : null;
    },
    hasCommand: overrides.hasCommand ?? ((c) => c === 'curl'),
    // A recorder, never the real writer: that one edits the GLOBAL Claude
    // profile, which here would be the developer's own (#2275).
    wirePromptHook: async () => {
      calls.promptHookWires += 1;
      return overrides.wirePromptHook ? overrides.wirePromptHook() : false;
    },
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
    // Downloads the right asset and swaps it in with the shared rename-aside function.
    expect(decoded).toContain('releases/download/v0.9.9/codegraph-win32-');
    expect(decoded).toContain(WINDOWS_SWAP_FUNCTION);
    expect(decoded).toMatch(/^\s*Install-CodeGraphFiles .* \$dest$/m);
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
    // Exit 1 is the script's "failed, install unchanged" code (#2185).
    expect(calls.errors.join('\n')).toMatch(/did not complete; your existing install was left as it was/i);
  });

  it('windows bundle: an incomplete rollback points at the reinstall command', async () => {
    const { deps, calls } = makeDeps(
      {
        method: { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/codegraph/current', installDir: 'C:/x/codegraph' },
        currentVersion: '0.9.8',
        platform: 'win32',
      },
      WINDOWS_UPGRADE_DAMAGED
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/could not be put back/i);
    expect(calls.logs.join('\n')).toContain('install.ps1 | iex');
    expect(calls.runs).toHaveLength(1); // no post-upgrade refresh/probe after a failure
  });

  it('windows bundle: any other exit code is reported as-is', async () => {
    const { deps, calls } = makeDeps(
      {
        method: { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/codegraph/current', installDir: 'C:/x/codegraph' },
        currentVersion: '0.9.8',
        platform: 'win32',
      },
      -1
    );
    expect(await runUpgrade({}, deps)).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/exited with code -1/i);
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

  it('npm on win32 routes through cmd.exe (a direct npm.cmd spawn EINVALs on modern Node)', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    await runUpgrade({}, deps);
    expect(calls.runs[0].cmd).toBe('cmd.exe');
    expect(calls.runs[0].args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calls.runs[0].args[3]).toBe(`npm install -g ${NPM_PACKAGE}@latest`);
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
// Beta signup offer — fires ONLY after a real, successful binary update.
// (The hook itself gates on TTY + the once-per-machine stored choice; see
// __tests__/beta-signup.test.ts. Here we pin WHEN the upgrade path invokes it.)
// ---------------------------------------------------------------------------

describe('runUpgrade beta signup offer', () => {
  function withSpy(deps: UpgradeDeps): { deps: UpgradeDeps; offered: () => number } {
    let n = 0;
    deps.offerBetaSignup = async () => { n += 1; };
    return { deps, offered: () => n };
  }

  it('offers after a successful npm upgrade', async () => {
    const { deps } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    const { offered } = withSpy(deps);
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(offered()).toBe(1);
  });

  it('does not offer on --check', async () => {
    const { deps } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    const { offered } = withSpy(deps);
    expect(await runUpgrade({ check: true }, deps)).toBe(0);
    expect(offered()).toBe(0);
  });

  it('does not offer when already up to date', async () => {
    const { deps } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.9' });
    const { offered } = withSpy(deps);
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(offered()).toBe(0);
  });

  it('does not offer when the upgrade fails', async () => {
    const { deps } = makeDeps(
      { method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' },
      1 // npm exits non-zero
    );
    const { offered } = withSpy(deps);
    expect(await runUpgrade({}, deps)).toBe(1);
    expect(offered()).toBe(0);
  });

  it('does not offer on npx / source no-op paths', async () => {
    for (const method of [
      { kind: 'npx' } as const,
      { kind: 'source', root: '/dev/codegraph' } as const,
    ]) {
      const { deps } = makeDeps({ method, currentVersion: '0.9.8' });
      const { offered } = withSpy(deps);
      expect(await runUpgrade({}, deps)).toBe(0);
      expect(offered()).toBe(0);
    }
  });

  it('a throwing offer never fails the upgrade', async () => {
    const { deps } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    deps.offerBetaSignup = async () => { throw new Error('boom'); };
    expect(await runUpgrade({}, deps)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Post-upgrade prompt-hook self-heal — only ever through deps (#2275). The
// real writer edits the GLOBAL Claude profile; while the upgrade called it
// directly, every successful fake upgrade in this file could wire the hook
// into the developer's own ~/.claude/settings.json.
// ---------------------------------------------------------------------------

describe('post-upgrade prompt-hook self-heal', () => {
  // A configured global Claude profile the REAL writer would act on, so an
  // upgrade that bypasses deps shows up as a settings.json written here.
  const KEYS = ['CLAUDE_CONFIG_DIR', 'CODEGRAPH_NO_PROMPT_HOOK', 'CODEGRAPH_PROMPT_HOOK'] as const;
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  let profile: string;

  function configureProfile(): void {
    fs.writeFileSync(
      path.join(profile, '.claude.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } } }),
    );
  }

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.CODEGRAPH_NO_PROMPT_HOOK;
    delete process.env.CODEGRAPH_PROMPT_HOOK;
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-claude-'));
    process.env.CLAUDE_CONFIG_DIR = profile;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('a successful upgrade wires the hook through deps, never the real writer', async () => {
    configureProfile();
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(fs.existsSync(path.join(profile, 'settings.json')), 'the real writer ran').toBe(false);
    expect(calls.promptHookWires).toBe(1);
  });

  it('notes the hook only when the writer changed something', async () => {
    const quiet = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    expect(await runUpgrade({}, quiet.deps)).toBe(0);
    expect(quiet.calls.logs.join('\n')).not.toMatch(/front-load hook/);

    const wired = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      wirePromptHook: async () => true,
    });
    expect(await runUpgrade({}, wired.deps)).toBe(0);
    expect(wired.calls.logs.join('\n')).toMatch(/Enabled the CodeGraph front-load hook/);
  });

  it('the kill-switch skips the writer entirely', async () => {
    process.env.CODEGRAPH_NO_PROMPT_HOOK = '1';
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(calls.promptHookWires).toBe(0);
  });

  it('does not wire on --check, when up to date, or when the upgrade fails', async () => {
    const check = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' });
    expect(await runUpgrade({ check: true }, check.deps)).toBe(0);
    const current = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.9' });
    expect(await runUpgrade({}, current.deps)).toBe(0);
    const failed = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' }, 1);
    expect(await runUpgrade({}, failed.deps)).toBe(1);
    for (const { calls } of [check, current, failed]) expect(calls.promptHookWires).toBe(0);
  });

  it('a throwing writer never fails the upgrade', async () => {
    const { deps } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      wirePromptHook: async () => { throw new Error('EACCES'); },
    });
    expect(await runUpgrade({}, deps)).toBe(0);
  });

  // The production writer itself, pointed at the temp profile above.
  it('the real writer wires a configured profile once, and leaves an unconfigured one alone', async () => {
    const settings = path.join(profile, 'settings.json');
    expect(await defaultWirePromptHook()).toBe(false);
    expect(fs.existsSync(settings)).toBe(false);

    configureProfile();
    expect(await defaultWirePromptHook()).toBe(true);
    const written = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(JSON.stringify(written.hooks.UserPromptSubmit)).toMatch(/prompt-hook/);
    expect(await defaultWirePromptHook()).toBe(false); // idempotent
  });
});

// ---------------------------------------------------------------------------
// Post-upgrade self-heal of installed agent surfaces
// ---------------------------------------------------------------------------

describe('post-upgrade refresh of installed agent surfaces', () => {
  it('runs `codegraph install --refresh` via the NEW binary after a successful npm upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'codegraph',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    // The refresh is spawned AFTER the binary swap, so the fresh install
    // (with the current templates) does the writing — not this process.
    const last = calls.runs[calls.runs.length - 1];
    expect(last?.cmd).toBe('codegraph');
    expect(last?.args).toEqual(['install', '--refresh']);
  });

  it('runs the Windows .cmd launcher through cmd.exe', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
      hasCommand: (cmd) => cmd === 'codegraph',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    const last = calls.runs[calls.runs.length - 1];
    expect(last?.cmd).toBe('cmd.exe');
    expect(last?.args).toEqual(['/d', '/s', '/c', 'codegraph install --refresh']);
  });

  it('skips the refresh when `codegraph` is not resolvable on PATH', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      // default hasCommand resolves only curl
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs.filter((r) => r.cmd === 'codegraph')).toHaveLength(0);
  });

  it('a failing refresh warns but does not fail the upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'codegraph',
    });
    deps.run = (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      return cmd === 'codegraph' ? 1 : 0;
    };
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.logs.join('\n')).toMatch(/install --refresh/);
  });

  it('does not run after a failed upgrade', async () => {
    const { deps, calls } = makeDeps(
      {
        method: { kind: 'npm', scope: 'global' },
        currentVersion: '0.9.8',
        hasCommand: (cmd) => cmd === 'codegraph',
      },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs.filter((r) => r.cmd === 'codegraph')).toHaveLength(0);
  });

  it('respects the CODEGRAPH_NO_INSTALL_REFRESH kill-switch', async () => {
    process.env.CODEGRAPH_NO_INSTALL_REFRESH = '1';
    try {
      const { deps, calls } = makeDeps({
        method: { kind: 'npm', scope: 'global' },
        currentVersion: '0.9.8',
        hasCommand: (cmd) => cmd === 'codegraph',
      });
      const code = await runUpgrade({}, deps);
      expect(code).toBe(0);
      expect(calls.runs.filter((r) => r.cmd === 'codegraph')).toHaveLength(0);
    } finally {
      delete process.env.CODEGRAPH_NO_INSTALL_REFRESH;
    }
  });

  it('skips the refresh when the version probe says a stale install shadows the new one', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'codegraph',
      capture: () => ({ code: 0, stdout: '0.9.8\n' }), // PATH still serves the OLD version
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    // Spawning `codegraph install --refresh` would execute the shadowed stale
    // binary — the exact staleness the refresh exists to heal.
    expect(calls.runs.filter((r) => r.cmd === 'codegraph')).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/run `codegraph install --refresh` once the PATH is fixed/);
  });
});

// ---------------------------------------------------------------------------
// Post-upgrade version probe — does the PATH-resolved `codegraph` serve the
// version we just installed, in THIS terminal?
// ---------------------------------------------------------------------------

describe('post-upgrade version probe', () => {
  const npmGlobal = { method: { kind: 'npm', scope: 'global' } as InstallMethod, currentVersion: '0.9.8' };

  it('match: confirms the same terminal already serves the new version', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'codegraph',
      capture: () => ({ code: 0, stdout: '0.9.9\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toEqual([{ cmd: 'codegraph', args: ['--version'] }]);
    const out = calls.logs.join('\n');
    expect(out).toMatch(/now reports v0\.9\.9/);
    expect(out).not.toMatch(/Open a new terminal/);
  });

  it('mismatch: warns that a shadowing install is still serving the old version', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'codegraph',
      capture: () => ({ code: 0, stdout: '0.9.8\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0); // the upgrade itself succeeded — warn, don't fail
    const out = calls.logs.join('\n');
    expect(out).toMatch(/still reports an older version/);
    expect(out).toMatch(/shadowing/);
    expect(out).toMatch(/which -a codegraph/);
  });

  it('inconclusive: falls back to the soft new-terminal hint when codegraph is not on PATH', async () => {
    const { deps, calls } = makeDeps(npmGlobal); // hasCommand resolves only curl
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/Open a new terminal/);
  });

  it('inconclusive: a failing or unparsable probe never warns about shadowing', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'codegraph',
      capture: () => ({ code: 0, stdout: 'something went wrong\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    const out = calls.logs.join('\n');
    expect(out).not.toMatch(/shadowing/);
    expect(out).toMatch(/Open a new terminal/);
  });

  it('parses the last non-empty line, so a runtime warning above the version is harmless', () => {
    const { deps } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'codegraph',
      capture: () => ({ code: 0, stdout: '(node:1) ExperimentalWarning: blah\nv0.9.9\n\n' }),
    });
    expect(verifyResolvedVersion('v0.9.9', deps)).toBe('match');
  });

  it('routes the probe through cmd.exe on Windows (.cmd launcher)', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      platform: 'win32',
      hasCommand: (c) => c === 'codegraph' || c === 'npm.cmd',
      capture: () => ({ code: 0, stdout: '0.9.9\r\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toEqual([{ cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'codegraph --version'] }]);
    expect(calls.logs.join('\n')).toMatch(/now reports v0\.9\.9/);
  });

  it('skips the probe for npm-local installs — PATH serves a different copy', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'local' },
      currentVersion: '0.9.8',
      hasCommand: (c) => c === 'codegraph',
      capture: () => ({ code: 0, stdout: '0.9.7\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toHaveLength(0);
    expect(calls.logs.join('\n')).not.toMatch(/shadowing/);
  });

  it('does not probe after a failed upgrade', async () => {
    const { deps, calls } = makeDeps(
      { ...npmGlobal, hasCommand: (c) => c === 'codegraph', capture: () => ({ code: 0, stdout: '0.9.9\n' }) },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.captures).toHaveLength(0);
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
