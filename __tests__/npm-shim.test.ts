/**
 * npm thin-installer launcher (`scripts/npm-shim.js`) tests.
 *
 * The shim runs on the user's own Node, locates the per-platform optionalDependency
 * bundle, and — when a registry mirror failed to deliver it (issue #303) — falls
 * back to downloading the bundle from GitHub Releases. These tests exercise that
 * shim as a real subprocess from a temp "main package" dir (its own package.json
 * + node_modules), so resolution and version lookup behave hermetically.
 *
 * The download/checksum paths run against a local self-signed HTTPS server via
 * CODEGRAPH_DOWNLOAD_BASE — no real network, no published release needed. The
 * shim is launched with async `spawn` (not spawnSync), so the test's event loop
 * stays free to serve those requests.
 *
 * POSIX only: the fake bundle launcher is a shell script and extraction uses the
 * system `tar`. Skipped on Windows (where the shim's exec path differs anyway).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

const SHIM_SRC = path.join(__dirname, '..', 'scripts', 'npm-shim.js');
const target = `${process.platform}-${process.arch}`;
const asset = `codegraph-${target}.tar.gz`;
const isWindows = process.platform === 'win32';

function hasOpenssl(): boolean {
  try { execSync('openssl version', { stdio: 'ignore' }); return true; } catch { return false; }
}
const CAN_NET = !isWindows && hasOpenssl();

function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-shim-${label}-`));
}

// A temp dir standing in for the installed @colbymchenry/codegraph main package.
function makePkg(version = '9.9.9-test'): string {
  const dir = mkTmp('pkg');
  fs.copyFileSync(SHIM_SRC, path.join(dir, 'npm-shim.js'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: '@colbymchenry/codegraph', version }) + '\n');
  return dir;
}

// A fake bundle launcher that prints a marker + its args, so we can prove the
// shim found and exec'd it (and passed args through).
function writeLauncher(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, 'codegraph');
  fs.writeFileSync(p, '#!/bin/sh\necho "FAKE_BUNDLE_RAN args:$*"\n');
  fs.chmodSync(p, 0o755);
}

// Launch the shim with async spawn so the in-process HTTPS server can respond
// while it runs (spawnSync would block this event loop and deadlock).
function runShim(pkgDir: string, args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(pkgDir, 'npm-shim.js'), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(isWindows)('npm-shim launcher', () => {
  it('runs the installed optional-dependency bundle without any download', async () => {
    const pkg = makePkg();
    const platformPkg = path.join(pkg, 'node_modules', '@colbymchenry', `codegraph-${target}`);
    writeLauncher(path.join(platformPkg, 'bin'));
    fs.writeFileSync(path.join(platformPkg, 'package.json'),
      JSON.stringify({ name: `@colbymchenry/codegraph-${target}`, version: '9.9.9-test' }) + '\n');
    const cache = mkTmp('cache');
    const r = await runShim(pkg, ['--probe-abc'], { CODEGRAPH_INSTALL_DIR: cache });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('FAKE_BUNDLE_RAN');
    expect(r.stdout).toContain('--probe-abc');     // args passed through
    expect(r.stderr).not.toContain('downloading'); // never reached the fallback
    expect(fs.existsSync(path.join(cache, 'bundles'))).toBe(false);
  });

  it('uses an already-cached bundle even when downloads are disabled', async () => {
    const pkg = makePkg('1.2.3-cached');
    const cache = mkTmp('cache');
    writeLauncher(path.join(cache, 'bundles', `${target}-1.2.3-cached`, 'bin'));
    const r = await runShim(pkg, ['--probe-xyz'], {
      CODEGRAPH_INSTALL_DIR: cache,
      CODEGRAPH_NO_DOWNLOAD: '1',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('FAKE_BUNDLE_RAN');
    expect(r.stdout).toContain('--probe-xyz');
    expect(r.stderr).toBe('');
  });

  it('prints actionable guidance and exits 1 when disabled with no bundle', async () => {
    const pkg = makePkg();
    const r = await runShim(pkg, ['--version'], {
      CODEGRAPH_INSTALL_DIR: mkTmp('cache'),
      CODEGRAPH_NO_DOWNLOAD: '1',
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no prebuilt bundle for ${target}`);
    expect(r.stderr).toContain(`@colbymchenry/codegraph-${target}`);
    expect(r.stderr).toContain('--registry=https://registry.npmjs.org');
    expect(r.stderr).toContain('install.sh');
  });
});

describe.skipIf(!CAN_NET)('npm-shim download fallback (local HTTPS)', () => {
  let server: https.Server;
  let port = 0;
  let fixtureBytes: Buffer;
  let fixtureSha: string;
  let sumsBody: string | null = null; // per-test: SHA256SUMS contents, or null for 404

  beforeAll(async () => {
    // Self-signed cert for the mock release host.
    const cdir = mkTmp('tls');
    const keyP = path.join(cdir, 'key.pem');
    const certP = path.join(cdir, 'cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyP} -out ${certP} -days 1 -subj "/CN=localhost"`,
      { stdio: 'ignore' },
    );

    // Build a fake bundle archive (codegraph-<target>/bin/codegraph), like a real release asset.
    const work = mkTmp('fixture');
    writeLauncher(path.join(work, `codegraph-${target}`, 'bin'));
    const archive = path.join(work, asset);
    execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(work)} codegraph-${target}`);
    fixtureBytes = fs.readFileSync(archive);
    fixtureSha = crypto.createHash('sha256').update(fixtureBytes).digest('hex');

    server = https.createServer({ key: fs.readFileSync(keyP), cert: fs.readFileSync(certP) }, (req, res) => {
      const url = req.url || '';
      if (url.endsWith(`/${asset}`)) {
        res.writeHead(200); res.end(fixtureBytes);
      } else if (url.endsWith('/SHA256SUMS')) {
        if (sumsBody === null) { res.writeHead(404); res.end('not found'); }
        else { res.writeHead(200); res.end(sumsBody); }
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }, 30000);

  afterAll(() => { server?.close(); });

  function netEnv(cache: string): Record<string, string> {
    return {
      CODEGRAPH_INSTALL_DIR: cache,
      CODEGRAPH_DOWNLOAD_BASE: `https://127.0.0.1:${port}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };
  }

  it('downloads, verifies the checksum, extracts, and execs the bundle', async () => {
    sumsBody = `${fixtureSha}  ${asset}\n`;
    const pkg = makePkg('5.0.0-net');
    const cache = mkTmp('cache');
    const r = await runShim(pkg, ['--probe-net'], netEnv(cache));

    expect(r.stderr).toContain('downloading');
    expect(r.stderr).toContain('checksum verified');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('FAKE_BUNDLE_RAN');
    expect(r.stdout).toContain('--probe-net');
    expect(fs.existsSync(path.join(cache, 'bundles', `${target}-5.0.0-net`, 'bin', 'codegraph'))).toBe(true);
  }, 20000);

  it('aborts (exit 1) on a checksum mismatch and caches nothing', async () => {
    sumsBody = `${'0'.repeat(64)}  ${asset}\n`;
    const pkg = makePkg('5.0.0-bad');
    const cache = mkTmp('cache');
    const r = await runShim(pkg, ['--version'], netEnv(cache));

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('checksum mismatch');
    expect(r.stdout).not.toContain('FAKE_BUNDLE_RAN'); // never exec'd a tampered bundle
    expect(fs.existsSync(path.join(cache, 'bundles', `${target}-5.0.0-bad`))).toBe(false);
  }, 20000);

  it('proceeds when no SHA256SUMS is published (older releases)', async () => {
    sumsBody = null; // 404
    const pkg = makePkg('5.0.0-nosums');
    const cache = mkTmp('cache');
    const r = await runShim(pkg, ['--version'], netEnv(cache));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('downloading');
    expect(r.stderr).not.toContain('checksum verified'); // skipped, not failed
    expect(r.stdout).toContain('FAKE_BUNDLE_RAN');
  }, 20000);
});
