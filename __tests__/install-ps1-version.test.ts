/**
 * install.ps1 resolves the version to install without the rate-limited GitHub
 * API (PR #560).
 *
 * `irm …/install.ps1 | iex` asked only the unauthenticated GitHub API for the
 * latest release. It allows 60 requests an hour per IP and then answers 403, so
 * a Windows install on a shared network or in CI died with a raw "(403)
 * Forbidden". A bare `CODEGRAPH_VERSION=1.6.2` built a download URL without the
 * `v` that release tags carry, which 404s. install.sh (#336) and
 * `codegraph upgrade` already read the release redirect first and add the `v`.
 *
 * These run the REAL resolver from install.ps1 — the block between its
 * `Resolve-CodeGraphVersion` markers — in Windows PowerShell, pointed at a
 * local stand-in for github.com and api.github.com. No request leaves the
 * machine.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

const INSTALL_PS1 = path.join(__dirname, '..', 'install.ps1');
const REPO = 'colbymchenry/codegraph';

/** The resolver exactly as install.ps1 ships it. */
function extractResolver(): string {
  const text = fs.readFileSync(INSTALL_PS1, 'utf8').replace(/\r\n/g, '\n');
  const m = /# >>> Resolve-CodeGraphVersion\n([\s\S]*?)# <<< Resolve-CodeGraphVersion/.exec(text);
  if (!m) throw new Error('install.ps1 has no Resolve-CodeGraphVersion block');
  return m[1]!;
}

/** A PowerShell single-quoted string literal. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe.runIf(process.platform === 'win32')('install.ps1 resolves the version to install (PR #560)', () => {
  let server: http.Server;
  let base = '';
  let web: 'redirect' | 'no-location' | 'error' = 'redirect';
  let api: 'ok' | 'rate-limited' = 'ok';
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === `/${REPO}/releases/latest`) {
        if (web === 'redirect') res.writeHead(302, { Location: `https://github.com/${REPO}/releases/tag/v9.8.7` });
        else if (web === 'no-location') res.writeHead(200, { 'Content-Type': 'text/html' });
        else res.writeHead(500);
        res.end();
      } else if (req.url === `/repos/${REPO}/releases/latest`) {
        res.writeHead(api === 'ok' ? 200 : 403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(api === 'ok' ? { tag_name: 'v9.8.6' } : { message: 'API rate limit exceeded for 127.0.0.1.' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
    web = 'redirect';
    api = 'ok';
  });

  /** Run the shipped resolver in Windows PowerShell against the stand-in (async: the stand-in runs here). */
  function resolveVersion(pinned: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      extractResolver(),
      `Resolve-CodeGraphVersion ${psq(pinned)} ${psq(REPO)} ${psq(base)} ${psq(base)}`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 60_000 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: stdout.trim(), stderr });
        },
      );
    });
  }

  it('reads the latest release from the redirect: one HEAD, not followed, no API call', async () => {
    const r = await resolveVersion('');
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('v9.8.7');
    expect(hits).toEqual([`HEAD /${REPO}/releases/latest`]);
  }, 60_000);

  it('falls back to the API when the redirect cannot be read', async () => {
    for (const mode of ['error', 'no-location'] as const) {
      web = mode;
      hits.length = 0;
      const r = await resolveVersion('');
      expect(r.stdout, mode).toBe('v9.8.6');
      expect(hits, mode).toEqual([`HEAD /${REPO}/releases/latest`, `GET /repos/${REPO}/releases/latest`]);
    }
  }, 60_000);

  it('stops with its own message, not a raw 403, when neither answers', async () => {
    web = 'error';
    api = 'rate-limited';
    const r = await resolveVersion('');
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('could not resolve the latest version');
    expect(r.stderr).toContain('CODEGRAPH_VERSION');
    expect(r.stderr).not.toContain('403');
  }, 60_000);

  it('adds the v to a bare pinned version, and asks GitHub nothing', async () => {
    expect((await resolveVersion('1.6.2')).stdout).toBe('v1.6.2');
    expect((await resolveVersion('v1.6.2')).stdout).toBe('v1.6.2');
    expect((await resolveVersion(' 1.6.2 ')).stdout).toBe('v1.6.2');
    expect(hits).toEqual([]);
  }, 60_000);
});
