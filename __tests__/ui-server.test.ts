/**
 * `codegraph ui` server — the loopback boundary (CG-41).
 *
 * This process serves the user's source code from a port on their machine, so
 * the tests that matter are the refusals: a foreign `Host` (DNS rebinding is
 * the only realistic attack on a loopback code viewer), a traversal out of the
 * asset root, a write method, a cross-origin read. The happy path — index.html
 * and hashed assets — is here mostly so a refusal that accidentally blocks
 * everything can't pass.
 *
 * Requests go through `http.request`, not `fetch`: `Host` is a forbidden header
 * name in undici, and forging it is the whole point of half these cases.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as childProcess from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  browserOpenCommand,
  openBrowser,
  cacheControlFor,
  contentTypeFor,
  isAllowedHost,
  isAllowedOrigin,
  isSafeRequestPath,
  PathRefusalError,
  resolveProjectFile,
  resolveStaticAsset,
  startUiServer,
  type UiServerHandle,
} from '../src/ui-server';

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}));

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * One request with full control over the request line and headers.
 *
 * `setHost: false` stops node from adding its own `Host`, and `path` is sent
 * verbatim — so a traversal case really does put `/../../x` on the wire.
 */
function request(
  port: number,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...options.headers };
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('codegraph ui server', () => {
  let tempDir: string;
  let viewerDir: string;
  let projectRoot: string;
  let server: UiServerHandle;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-server-'));

    // A stand-in for dist/viewer: same shape (index.html + hashed assets/), so
    // the tests don't need the Svelte build to have run.
    viewerDir = path.join(tempDir, 'viewer');
    fs.mkdirSync(path.join(viewerDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(viewerDir, 'index.html'),
      '<!doctype html><html><body><div id="app"></div>' +
        '<script type="module" src="./assets/index-abc123.js"></script></body></html>'
    );
    fs.writeFileSync(path.join(viewerDir, 'assets', 'index-abc123.js'), 'export const viewer = 1;\n');
    fs.writeFileSync(path.join(viewerDir, 'assets', 'index-abc123.css'), ':root{color:#16150f}\n');

    projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'auth.ts'), 'export const token = 1;\n');

    // A file OUTSIDE both roots that a traversal would be trying to reach.
    fs.writeFileSync(path.join(tempDir, 'secret.txt'), 'SUPER-SECRET-VALUE\n');

    server = await startUiServer({ projectRoot, viewerDir, port: 0 });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('serving the viewer', () => {
    it('serves index.html at the root', async () => {
      const res = await request(server.port, '/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain('<div id="app">');
    });

    it('serves index.html directly too', async () => {
      const res = await request(server.port, '/index.html');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<div id="app">');
    });

    it('serves hashed assets with their real content type', async () => {
      const js = await request(server.port, '/assets/index-abc123.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(js.body).toContain('export const viewer');

      const css = await request(server.port, '/assets/index-abc123.css');
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    });

    it('caches hashed assets forever and index.html never', async () => {
      const asset = await request(server.port, '/assets/index-abc123.js');
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const index = await request(server.port, '/');
      expect(index.headers['cache-control']).toBe('no-store');
    });

    it('falls back to index.html for an unknown route, but not for a missing asset', async () => {
      // A hash-routed app only ever asks for `/`, but a hand-typed deep path
      // should still open the app.
      const route = await request(server.port, '/s/some-symbol-id');
      expect(route.status).toBe(200);
      expect(route.body).toContain('<div id="app">');

      // A missing FILE must 404 — answering with HTML would hand the browser a
      // script that isn't one, and hide a broken build.
      const asset = await request(server.port, '/assets/index-doesnotexist.js');
      expect(asset.status).toBe(404);
    });

    it('answers HEAD with the same headers and no body', async () => {
      const res = await request(server.port, '/', { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-length']).toBeDefined();
      expect(res.body).toBe('');
    });
  });

  describe('binding', () => {
    it('listens on loopback only', () => {
      const address = server.server.address();
      expect(address).not.toBeNull();
      expect(typeof address === 'object' ? address?.address : null).toBe('127.0.0.1');
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    });

    it('falls back to the next free port when the preferred one is taken', async () => {
      const blocker = http.createServer(() => {});
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const taken = (blocker.address() as { port: number }).port;

      const second = await startUiServer({ projectRoot, viewerDir, port: taken });
      try {
        expect(second.port).not.toBe(taken);
        expect(second.port).toBeGreaterThan(taken);
        // …and it actually works on the port it landed on.
        const res = await request(second.port, '/');
        expect(res.status).toBe(200);
      } finally {
        await second.close();
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it('refuses to move off a port the caller pinned', async () => {
      const blocker = http.createServer(() => {});
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const taken = (blocker.address() as { port: number }).port;

      try {
        await expect(
          startUiServer({ projectRoot, viewerDir, port: taken, portFallback: false })
        ).rejects.toThrow(/already in use/i);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  describe('Host allowlist (DNS rebinding)', () => {
    it('serves the loopback names', async () => {
      for (const host of ['127.0.0.1', 'localhost', '[::1]', `localhost:${server.port}`, `[::1]:${server.port}`]) {
        const res = await request(server.port, '/', { headers: { Host: host } });
        expect(res.status, `Host: ${host}`).toBe(200);
      }
    });

    it('refuses a foreign Host', async () => {
      for (const host of ['evil.example', `evil.example:${server.port}`, 'attacker.localhost.evil.com']) {
        const res = await request(server.port, '/', { headers: { Host: host } });
        expect(res.status, `Host: ${host}`).toBe(403);
        expect(res.body).not.toContain('<div id="app">');
      }
    });

    it('refuses a loopback Host carrying someone else\u2019s port', async () => {
      const res = await request(server.port, '/', { headers: { Host: '127.0.0.1:9' } });
      expect(res.status).toBe(403);
    });

    it('refuses a malformed or missing Host', async () => {
      const malformed = await request(server.port, '/', { headers: { Host: '127.0.0.1:notaport' } });
      expect(malformed.status).toBe(403);
      // Node's client insists on sending something for Host, so the empty-value
      // case is covered by the unit assertions on isAllowedHost below.
    });

    it('refuses before touching the filesystem — even for an asset', async () => {
      const res = await request(server.port, '/assets/index-abc123.js', {
        headers: { Host: 'evil.example' },
      });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('export const viewer');
    });
  });

  describe('cross-origin', () => {
    it('never sends CORS headers', async () => {
      const res = await request(server.port, '/');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    });

    it('refuses a request carrying a foreign Origin', async () => {
      const res = await request(server.port, '/', { headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
    });

    it('allows the viewer\u2019s own origin', async () => {
      const res = await request(server.port, '/', {
        headers: { Origin: `http://127.0.0.1:${server.port}` },
      });
      expect(res.status).toBe(200);
    });

    it('sends the hardening headers on every response', async () => {
      const res = await request(server.port, '/');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
    });
  });

  describe('methods', () => {
    it('refuses every method it has never answered', async () => {
      for (const method of ['PUT', 'PATCH', 'OPTIONS', 'TRACE']) {
        const res = await request(server.port, '/', { method });
        expect(res.status, method).toBe(405);
        expect(res.headers['allow']).toBe('GET, HEAD, POST, DELETE');
      }
    });

    /**
     * The static side stayed a pure reader when `/api/trails` gained a write
     * (CG-60). A POST at an asset path is 405 with `Allow: GET, HEAD` — the
     * narrower answer, since nothing under the viewer bundle will ever take
     * one.
     */
    it('refuses a write outside /api/, whatever it carries', async () => {
      for (const method of ['POST', 'DELETE']) {
        const res = await request(server.port, '/', {
          method,
          headers: { 'X-CodeGraph-UI': '1' },
        });
        expect(res.status, method).toBe(405);
        expect(res.headers['allow']).toBe('GET, HEAD');
      }
    });

    /**
     * Under `/api/` a write is answered as JSON even when refused — the viewer
     * parses these, and a text/plain body surfaces as a parse error rather than
     * the refusal it is. No API is mounted on this server, so the refusal is
     * the boundary's own and not an endpoint's.
     */
    it('refuses an unmarked write under /api/ as JSON', async () => {
      const res = await request(server.port, '/api/trails', { method: 'POST' });
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body).code).toBe('refused');
    });
  });

  describe('paths outside the asset root', () => {
    const traversals = [
      '/../secret.txt',
      '/../../secret.txt',
      '/assets/../../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/....//secret.txt',
    ];

    it('never serves a file outside the viewer directory', async () => {
      for (const traversal of traversals) {
        const res = await request(server.port, traversal);
        expect(res.body, traversal).not.toContain('SUPER-SECRET-VALUE');
        expect(res.status, traversal).not.toBe(200);
      }
    });

    it('404s an absolute system path rather than reading it', async () => {
      const res = await request(server.port, '/etc/passwd');
      expect(res.body).not.toContain('root:');
      // No such file under the viewer root; an extension-less path is a route.
      expect(res.status).toBe(200);
      expect(res.body).toContain('<div id="app">');

      const shadow = await request(server.port, '/etc/hosts.txt');
      expect(shadow.status).toBe(404);
    });

    it('404s a NUL-truncation attempt', async () => {
      const res = await request(server.port, '/index.html%00.png');
      expect(res.status).toBe(404);
    });
  });

  describe('/api is reserved', () => {
    it('404s as JSON, never as the app shell', async () => {
      const res = await request(server.port, '/api/nodes');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(res.body)).toHaveProperty('error');
      expect(res.body).not.toContain('<div id="app">');
    });

    it('hands requests to a mounted handler with a decoded path and query', async () => {
      const seen: Array<{ pathname: string; symbol: string | null; root: string }> = [];
      const withApi = await startUiServer({
        projectRoot,
        viewerDir,
        port: 0,
        api: (_req, res, ctx) => {
          seen.push({
            pathname: ctx.pathname,
            symbol: ctx.query.get('symbol'),
            root: ctx.projectRoot,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          return true;
        },
      });
      try {
        const res = await request(withApi.port, '/api/node?symbol=parse%20Token');
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true });
        expect(seen).toEqual([{ pathname: '/api/node', symbol: 'parse Token', root: projectRoot }]);
      } finally {
        await withApi.close();
      }
    });

    it('turns a throwing handler into a JSON 500, not a crashed server', async () => {
      const withApi = await startUiServer({
        projectRoot,
        viewerDir,
        port: 0,
        api: () => {
          throw new Error('handler blew up');
        },
      });
      try {
        const res = await request(withApi.port, '/api/boom');
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toContain('handler blew up');
        // Still alive afterwards.
        expect((await request(withApi.port, '/')).status).toBe(200);
      } finally {
        await withApi.close();
      }
    });
  });
});

describe('resolveProjectFile — the source read chokepoint', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-paths-'));
    projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'auth.ts'), 'export const token = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'secret.txt'), 'SUPER-SECRET-VALUE\n');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a file inside the project', () => {
    expect(resolveProjectFile(projectRoot, 'src/auth.ts')).toBe(
      fs.realpathSync(path.join(projectRoot, 'src', 'auth.ts'))
    );
  });

  it('refuses traversal out of the project', () => {
    for (const escape of ['../secret.txt', 'src/../../secret.txt', '..%2fsecret.txt']) {
      expect(() => resolveProjectFile(projectRoot, escape), escape).toThrow(PathRefusalError);
    }
  });

  it('refuses an absolute path', () => {
    expect(() => resolveProjectFile(projectRoot, path.join(tempDir, 'secret.txt'))).toThrow(
      PathRefusalError
    );
  });

  it('refuses an empty path', () => {
    expect(() => resolveProjectFile(projectRoot, '')).toThrow(PathRefusalError);
    expect(() => resolveProjectFile(projectRoot, '   ')).toThrow(PathRefusalError);
  });

  it('refuses a NUL byte', () => {
    expect(() => resolveProjectFile(projectRoot, 'src/auth.ts%00.png')).toThrow(PathRefusalError);
  });

  // `/etc` resolves to a non-existent `C:\etc` on Windows, so the sensitive-path
  // list only means anything on POSIX.
  it.runIf(process.platform !== 'win32')('refuses a sensitive system directory as the root', () => {
    expect(() => resolveProjectFile('/etc', 'passwd')).toThrow(PathRefusalError);
    expect(() => resolveProjectFile('/', 'etc/passwd')).toThrow(PathRefusalError);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlink pointing out of the project (#527)', () => {
    const link = path.join(projectRoot, 'src', 'escape.ts');
    fs.symlinkSync(path.join(tempDir, 'secret.txt'), link);
    try {
      expect(() => resolveProjectFile(projectRoot, 'src/escape.ts')).toThrow(PathRefusalError);
    } finally {
      fs.unlinkSync(link);
    }
  });
});

describe('security helpers', () => {
  it('isAllowedHost accepts only loopback names on our port', () => {
    expect(isAllowedHost('127.0.0.1', 4747)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4747', 4747)).toBe(true);
    expect(isAllowedHost('localhost:4747', 4747)).toBe(true);
    expect(isAllowedHost('LOCALHOST', 4747)).toBe(true);
    expect(isAllowedHost('[::1]:4747', 4747)).toBe(true);

    expect(isAllowedHost(undefined, 4747)).toBe(false);
    expect(isAllowedHost('', 4747)).toBe(false);
    expect(isAllowedHost('evil.example', 4747)).toBe(false);
    expect(isAllowedHost('127.0.0.1:4748', 4747)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.example', 4747)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:4747', 4747)).toBe(false);
    expect(isAllowedHost('127.0.0.1:4747:4747', 4747)).toBe(false);
    // Unbracketed IPv6 is malformed per RFC 7230 — rejected, not guessed at.
    expect(isAllowedHost('::1', 4747)).toBe(false);
    // A non-loopback address that merely resolves here still fails the check.
    expect(isAllowedHost('192.168.1.5:4747', 4747)).toBe(false);
  });

  it('isAllowedOrigin allows absent and same-origin, refuses everything else', () => {
    expect(isAllowedOrigin(undefined, 4747)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4747', 4747)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4747', 4747)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:4747', 4747)).toBe(true);

    expect(isAllowedOrigin('null', 4747)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', 4747)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:4748', 4747)).toBe(false);
    expect(isAllowedOrigin('file://', 4747)).toBe(false);
    expect(isAllowedOrigin('not a url', 4747)).toBe(false);
  });

  it('isSafeRequestPath rejects a `..` segment however it is spelled', () => {
    expect(isSafeRequestPath('/')).toBe(true);
    expect(isSafeRequestPath('/assets/index-abc123.js')).toBe(true);
    expect(isSafeRequestPath('/s/Some.Symbol')).toBe(true);

    expect(isSafeRequestPath('/../secret')).toBe(false);
    expect(isSafeRequestPath('/a/../../secret')).toBe(false);
    expect(isSafeRequestPath('/%2e%2e/secret')).toBe(false);
    expect(isSafeRequestPath('/..%2Fsecret')).toBe(false);
    expect(isSafeRequestPath('/a%00b')).toBe(false);
    expect(isSafeRequestPath('/a\\b')).toBe(false);
    expect(isSafeRequestPath('/%zz')).toBe(false);
  });

  it('resolveStaticAsset returns null for anything that is not a file in the root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-static-'));
    try {
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'index.html'), 'x');
      expect(resolveStaticAsset(dir, '/index.html')).toBe(
        fs.realpathSync(path.join(dir, 'index.html'))
      );
      expect(resolveStaticAsset(dir, '/assets')).toBeNull(); // a directory
      expect(resolveStaticAsset(dir, '/missing.js')).toBeNull();
      expect(resolveStaticAsset(dir, '/../etc/passwd')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contentTypeFor covers the viewer bundle and defaults safely', () => {
    expect(contentTypeFor('a/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a/index-abc.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a/archivo.woff2')).toBe('font/woff2');
    expect(contentTypeFor('a/thing.unknownext')).toBe('application/octet-stream');
  });

  it('cacheControlFor pins hashed assets and never index.html', () => {
    expect(cacheControlFor(path.join('assets', 'index-abc.js'))).toContain('immutable');
    expect(cacheControlFor('index.html')).toBe('no-store');
  });
});

describe('browserOpenCommand', () => {
  it('does not spawn a browser when CODEGRAPH_BROWSER=none', () => {
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Unexpected browser launch');
    });
    vi.stubEnv('CODEGRAPH_BROWSER', 'none');
    try {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        expect(openBrowser('http://127.0.0.1:4747', platform)).toBe(false);
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('uses the platform opener', () => {
    expect(browserOpenCommand('http://x', 'darwin')).toEqual({ command: 'open', args: ['http://x'] });
    expect(browserOpenCommand('http://x', 'linux')).toEqual({ command: 'xdg-open', args: ['http://x'] });
    expect(browserOpenCommand('http://x', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://x'],
    });
  });

  it('honours the CODEGRAPH_BROWSER override', () => {
    expect(browserOpenCommand('http://x', 'darwin', 'firefox')).toEqual({
      command: 'firefox',
      args: ['http://x'],
    });
    // Windows routes the override through cmd so a `.cmd`/`.bat` shim — which
    // CreateProcess cannot launch directly — still works.
    expect(browserOpenCommand('http://x', 'win32', 'C:\\tools\\open.cmd')).toEqual({
      command: 'cmd',
      args: ['/c', 'C:\\tools\\open.cmd', 'http://x'],
    });
    for (const off of ['none', 'NONE', '0', 'false', 'off', '', '  ']) {
      expect(browserOpenCommand('http://x', 'darwin', off), off).toBeNull();
    }
  });
});
