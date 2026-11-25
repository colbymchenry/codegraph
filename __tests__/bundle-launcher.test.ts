import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const windows = process.platform === 'win32';
const bash = windows
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')
  : 'bash';
const recipe = fs.readFileSync(path.resolve('scripts/build-bundle.sh'), 'utf8');
// Execute the release recipe itself, without downloading Node or rebuilding the UI.
const launcherRecipe = recipe.slice(recipe.indexOf('# 4. Vendored'), recipe.indexOf('# 5. Archive'));
const archiveRecipe = recipe.slice(recipe.indexOf('# 5. Archive'));
const roots: string[] = [];
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1' };

function shell(script: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  // A file avoids Windows command-line quoting altering the recipe's printf
  // escapes or our argument fixtures before Bash even reads them.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shell-'));
  roots.push(root);
  const file = path.join(root, 'test.sh');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(file, `set -- ${args.map(quote).join(' ')}\n${script}`);
  return spawnSync(bash, ['--noprofile', '--norc', file], {
    encoding: 'utf8', timeout: 30_000, env: { ...env, ...extraEnv }, input,
  });
}

function stage(osfam = windows ? 'win32' : process.platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph bundle space '));
  roots.push(root);
  const bundle = path.join(root, `codegraph-${osfam}-x64`);
  fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'lib/dist/bin'), { recursive: true });
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  const node = windows ? '$(cygpath -u "$2")' : '$2';
  const result = shell(`set -eu\nSTAGE="${convert}"\nNODE_BIN="${node}"\nOSFAM="$3"\n${launcherRecipe}`, [bundle, process.execPath, osfam]);
  expect(result.status, result.stderr || String(result.error)).toBe(0);
  return { root, bundle };
}

function invoke(bundle: string, command: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  // Exclude system Node: execution must use the runtime in the bundle.
  return shell(`STAGE="${convert}"\nshift\nPATH="$STAGE/bin:/usr/bin:/bin"\nexport PATH\n${command}`,
    [bundle, ...args], extraEnv, input);
}

function probe(bundle: string) {
  fs.writeFileSync(path.join(bundle, 'lib/dist/bin/codegraph.js'), `
console.log(JSON.stringify({args: process.argv.slice(2), flags: process.execArgv,
  host: process.env.CODEGRAPH_HOST_PPID, exe: process.execPath}));
process.exit(23);
`);
}

function checkForwarding(bundle: string) {
  probe(bundle);
  const args = ['two words', '', 'quote"value', "single'value", '$literal', '*.ts', 'a&b'];
  const result = invoke(bundle, 'codegraph "$@"', args, { CODEGRAPH_HOST_PPID: '12345' });
  expect(result.status, result.stderr).toBe(23);
  const output = JSON.parse(result.stdout);
  expect(output.args).toEqual(args);
  expect(output.flags).toEqual(['--liftoff-only', '--disable-warning=ExperimentalWarning']);
  expect(output.host).toBe('12345');
  expect(fs.realpathSync(output.exe)).toBe(fs.realpathSync(path.join(bundle, windows ? 'node.exe' : 'node')));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('bundled launchers (#1278)', () => {
  it.runIf(!windows)('preserves POSIX arguments, exit status, runtime flags and host PID', () => {
    checkForwarding(stage().bundle);
  });

  it.runIf(windows)('runs from Git Bash in a spaced path and forwards arguments, exit status, flags and host PID', () => {
    checkForwarding(stage().bundle);
  });

  it.runIf(windows)('runs the real CLI and prompt hook in Git Bash, and keeps cmd and PowerShell working', () => {
    const { bundle } = stage();
    fs.rmSync(path.join(bundle, 'lib/dist'), { recursive: true });
    fs.symlinkSync(path.resolve('dist'), path.join(bundle, 'lib/dist'), 'junction');
    const version = require('../package.json').version;
    const result = invoke(bundle, 'codegraph --version');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    const hook = invoke(bundle, 'codegraph prompt-hook', [], {}, '{"prompt":"test"}\n');
    expect(hook.status, hook.stderr).toBe(0);
    const bin = path.join(bundle, 'bin');
    for (const [exe, args] of [
      ['cmd.exe', ['/d', '/s', '/c', 'codegraph --version']],
      ['powershell.exe', ['-NoProfile', '-Command', 'codegraph --version']],
    ] as const) {
      const control = spawnSync(exe, [...args], {
        cwd: bin, encoding: 'utf8', timeout: 30_000,
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')),
          Path: `${bin};${process.env.Path || process.env.PATH}`,
        },
      });
      expect(control.status, control.stderr).toBe(0);
      expect(control.stdout.trim(), exe).toBe(version);
    }
  });

  it.runIf(!windows).each(['x64', 'arm64'])('ships both launchers in the Windows %s archive', (arch) => {
    const { root, bundle } = stage('win32');
    const target = `win32-${arch}`;
    if (arch !== 'x64') fs.renameSync(bundle, path.join(root, `codegraph-${target}`));
    const result = shell(`set -eu\nWORK="$1"\nOUT="$1/release"\nOSFAM=win32\nTARGET="$2"\n${archiveRecipe}`, [root, target]);
    expect(result.status, result.stderr).toBe(0);
    const list = spawnSync('unzip', ['-Z1', path.join(root, 'release', `codegraph-${target}.zip`)], { encoding: 'utf8' });
    expect(list.status, list.stderr).toBe(0);
    const entries = list.stdout.split('\n');
    for (const file of ['bin/codegraph', 'bin/codegraph.cmd', 'node.exe']) {
      expect(entries).toContain(`codegraph-${target}/${file}`);
    }
  });
});

describe('bundled Node runtime (#2617)', () => {
  it('ships a Node 24 release with the fix for the Windows abort at exit', () => {
    // The release workflow passes only the target, so the recipe's default
    // version is the Node every release bundles.
    const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
    const calls = workflow.match(/build-bundle\.sh[^\r\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.trim()).toBe('build-bundle.sh "$t"');

    const pin = /^NODE_VERSION="\$\{2:-v(\d+)\.(\d+)\.(\d+)\}"\r?$/m.exec(recipe);
    expect(pin, 'default NODE_VERSION in scripts/build-bundle.sh').not.toBeNull();
    const [major, minor] = pin!.slice(1, 3).map(Number);
    // The CLI refuses to run on Node 25 and later.
    expect(major).toBe(24);
    // Node 24 before 24.20.0 can abort on Windows as the process exits, after
    // the command's work is done (0xC0000409, nodejs/node#56645).
    expect(minor).toBeGreaterThanOrEqual(20);
  });
});

describe('bundled Node security release (#2780)', () => {
  const archive = 'node-v24.22.1-linux-x64.tar.gz';

  // Step 1 of the release recipe, run against a stand-in for nodejs.org: `curl`
  // copies the requested file out of `site/` and logs the URL it was asked for.
  function download(sums: (sha: string) => string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-download-'));
    roots.push(root);
    const site = path.join(root, 'site');
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(site, 'node-v24.22.1-linux-x64', 'bin'), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(site, 'node-v24.22.1-linux-x64', 'bin', 'node'), '#!/bin/sh\n');
    const arg = (n: number) => windows ? `$(cygpath -u "$${n}")` : `$${n}`;
    // Packed the way nodejs.org packs a release: one top-level folder.
    const pack = shell(`set -eu\ncd "${arg(1)}"\ntar -czf ${archive} node-v24.22.1-linux-x64`, [site]);
    expect(pack.status, pack.stderr).toBe(0);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(site, archive))).digest('hex');
    fs.writeFileSync(path.join(site, 'SHASUMS256.txt'), sums(sha));
    const step = recipe.slice(recipe.indexOf('# 1. Download'), recipe.indexOf('# 2. Build'));
    const result = shell(`set -euo pipefail
WORK="${arg(1)}"
SITE="${arg(2)}"
TARGET=linux-x64 OSFAM=linux ARCH=x64 NODE_VERSION=v24.22.1
curl() {
  local url='' out=''
  while [ $# -gt 0 ]; do
    case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
  done
  printf '%s\\n' "$url" >> "$WORK/urls"
  cp "$SITE/\${url##*/}" "$out"
}
${step}
printf 'NODE_BIN=%s\\n' "$NODE_BIN"`, [work, site]);
    const urls = fs.existsSync(path.join(work, 'urls'))
      ? fs.readFileSync(path.join(work, 'urls'), 'utf8').trim().split('\n')
      : [];
    return { result, work, urls };
  }

  it('ships Node 24.22.1, the October 2026 security release, or a later 24.x', () => {
    const pin = /^NODE_VERSION="\$\{2:-v(\d+)\.(\d+)\.(\d+)\}"\r?$/m.exec(recipe);
    expect(pin, 'default NODE_VERSION in scripts/build-bundle.sh').not.toBeNull();
    const [major, minor, patch] = pin!.slice(1, 4).map(Number);
    expect(major).toBe(24);
    // 24.22.1 fixes eight CVEs (four rated High) and ships OpenSSL 3.5.9.
    expect(minor > 22 || (minor === 22 && patch >= 1), `v${major}.${minor}.${patch}`).toBe(true);
  });

  it('unpacks the Node download once it matches the SHA-256 nodejs.org publishes for it', () => {
    const other = 'f'.repeat(64);
    const { result, work, urls } = download((sha) =>
      `${other}  node-v24.22.1-darwin-arm64.tar.gz\n${sha}  ${archive}\n${other}  node-v24.22.1-win-x64.zip\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(urls).toEqual([
      `https://nodejs.org/dist/v24.22.1/${archive}`,
      'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt',
    ]);
    expect(fs.existsSync(path.join(work, 'node-v24.22.1-linux-x64', 'bin', 'node'))).toBe(true);
    expect(result.stdout).toMatch(/^NODE_BIN=.*node-v24\.22\.1-linux-x64\/bin\/node\r?$/m);
  });

  it.each([
    ['whose SHA-256 differs from the published one', () => `${'0'.repeat(64)}  ${archive}\n`],
    ['that the published list leaves out', (sha: string) => `${sha}  node-v24.22.1-linux-arm64.tar.gz\n`],
  ])('refuses a Node download %s, before unpacking it', (_, sums) => {
    const { result, work } = download(sums);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${archive} does not match the SHA-256 that nodejs.org lists for v24.22.1`);
    expect(fs.existsSync(path.join(work, 'node-v24.22.1-linux-x64'))).toBe(false);
  });
});
