/**
 * `codegraph ui` — the CLI face of the viewer server (CG-41).
 *
 * Exercised end-to-end against the built binary, because the things worth
 * pinning here are the ones that only exist once commander, the project
 * resolver and the server are wired together: the help text, the friendly
 * "not indexed" guidance, the sensitive-directory refusal, and whether
 * `--no-open` actually stops a browser from being launched.
 *
 * The browser check works by pointing `CODEGRAPH_BROWSER` at a script that
 * touches a marker file — so "did it try to open a browser" becomes an
 * observable fact rather than a promise.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DEFAULT_UI_PORT as DEFAULT_PORT } from '../src/ui-server/constants';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

const BASE_ENV = {
  ...process.env,
  CODEGRAPH_NO_DAEMON: '1',
  CODEGRAPH_WASM_RELAUNCHED: '1',
  NO_COLOR: '1',
};

/** Run the CLI to completion, capturing stdout+stderr and the exit code. */
function runCli(args: string[], env: Record<string, string> = {}): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf-8',
      env: { ...BASE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** GET a path from a running viewer, with a valid loopback Host. */
function get(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Start `codegraph ui` and wait for the URL it prints.
 *
 * The banner IS the readiness signal: the server is bound before the URL is
 * printed, so anything the test does after this line is talking to a live
 * socket.
 */
function startViewer(
  args: string[],
  env: Record<string, string>
): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'ui', ...args], {
      env: { ...BASE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codegraph ui never printed a URL. Output:\n${output}`));
    }, 30_000);

    const onChunk = (chunk: Buffer): void => {
      output += chunk.toString('utf-8');
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), output: () => output });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`codegraph ui exited with ${code} before serving. Output:\n${output}`));
    });
  });
}

async function stopViewer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    // A viewer that ignores SIGTERM must not hang the suite.
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000).unref();
  });
}

describe('codegraph ui — help', () => {
  it('reads well and documents the flags', () => {
    const { code, output } = runCli(['ui', '--help']);
    expect(code).toBe(0);
    expect(output).toContain('--port');
    expect(output).toContain('--no-open');
    expect(output).toContain('4747');
    expect(output).toContain('127.0.0.1');
    expect(output).toContain('read-only');
    expect(output).toContain('Examples:');
    expect(output).toContain('CODEGRAPH_BROWSER');
  });

  it('works through `codegraph help ui`', () => {
    const viaHelpCommand = runCli(['help', 'ui']);
    const viaFlag = runCli(['ui', '--help']);
    expect(viaHelpCommand.code).toBe(0);
    expect(viaHelpCommand.output).toBe(viaFlag.output);
  });

  it('is listed in the top-level help, and `web` is an alias', () => {
    const top = runCli(['--help']);
    expect(top.output).toContain('ui|web [options] [path]');
    const viaAlias = runCli(['help', 'web']);
    expect(viaAlias.code).toBe(0);
    expect(viaAlias.output).toContain('--no-open');
  });

  it('rejects a nonsense --port with a plain message, not a stack trace', () => {
    const { code, output } = runCli(['ui', '--port', 'banana']);
    expect(code).toBe(1);
    expect(output).toContain('--port must be a whole number');
    expect(output).not.toContain('at Object.');
  });
});

describe('codegraph ui — refusals', () => {
  let unindexed: string;

  beforeAll(() => {
    unindexed = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-unindexed-'));
    fs.writeFileSync(path.join(unindexed, 'a.ts'), 'export const a = 1;\n');
  });

  afterAll(() => {
    fs.rmSync(unindexed, { recursive: true, force: true });
  });

  it('gives friendly guidance — never a stack trace — when there is no index', () => {
    const { code, output } = runCli(['ui', unindexed]);
    expect(code).toBe(1);
    expect(output).toContain('No CodeGraph index found');
    expect(output).toContain('codegraph init');
    expect(output).not.toContain('at Object.');
    expect(output).not.toContain('Error:');
  });

  // `/etc` is only sensitive on POSIX; on Windows it resolves to a
  // non-existent `C:\etc` and the "no index" path handles it instead.
  it.runIf(process.platform !== 'win32')('refuses a sensitive system directory', () => {
    const { code, output } = runCli(['ui', '/etc']);
    expect(code).toBe(1);
    expect(output).toContain('Refusing to operate on sensitive');
  });
});

describe('codegraph ui — serving', () => {
  let projectDir: string;
  let markerDir: string;
  let opener: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-cli-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(
      path.join(projectDir, 'src', 'auth.ts'),
      'export function parseToken(t: string){ return t.trim(); }\n'
    );
    const cg = CodeGraph.initSync(projectDir);
    await cg.indexAll();
    cg.close();

    // A stand-in browser: records that it was launched, and with what.
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-open-'));
    const markerFile = path.join(markerDir, 'opened.txt');
    if (process.platform === 'win32') {
      opener = path.join(markerDir, 'open.cmd');
      fs.writeFileSync(opener, `@echo %1 > "${markerFile}"\r\n`);
    } else {
      opener = path.join(markerDir, 'open.sh');
      fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${markerFile}"\n`);
      fs.chmodSync(opener, 0o755);
    }
  }, 120_000);

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
  });

  const markerFile = (): string => path.join(markerDir, 'opened.txt');

  /**
   * The opener is async (detached); give it a moment before concluding.
   *
   * Waits for CONTENT, not merely for the file to appear. Shell redirection
   * creates the target before the command writes into it — `cmd.exe` opens the
   * `>` target as it parses the line, ahead of `echo` — so an existence check
   * can return a file that is real but still empty. Callers that expect no
   * launch still get null: a file that never gains content times out the same
   * as one that never appears.
   */
  async function waitForMarker(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (fs.existsSync(markerFile())) {
        const body = fs.readFileSync(markerFile(), 'utf-8');
        if (body.trim() !== '') return body;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('serves the viewer and prints where it is', async () => {
    const viewer = await startViewer(['--no-open', '--port', '0', projectDir], {});
    try {
      const res = await get(viewer.port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<div id="app">');

      const banner = viewer.output();
      expect(banner).toContain('CodeGraph viewer');
      expect(banner).toContain(projectDir);
      expect(banner).toContain('this machine only');
    } finally {
      await stopViewer(viewer.child);
    }
  }, 60_000);

  it('honours --no-open: no browser is launched', async () => {
    fs.rmSync(markerFile(), { force: true });
    const viewer = await startViewer(['--no-open', '--port', '0', projectDir], {
      CODEGRAPH_BROWSER: opener,
    });
    try {
      // Confirm the server is genuinely up before concluding "nothing opened" —
      // otherwise this passes for the wrong reason.
      expect((await get(viewer.port, '/')).status).toBe(200);
      expect(await waitForMarker(1_500)).toBeNull();
      expect(viewer.output()).toContain('Open that URL in a browser');
      expect(viewer.output()).not.toContain('Opening your browser');
    } finally {
      await stopViewer(viewer.child);
    }
  }, 60_000);

  it('opens the browser at the served URL when --no-open is absent', async () => {
    fs.rmSync(markerFile(), { force: true });
    const viewer = await startViewer(['--port', '0', projectDir], { CODEGRAPH_BROWSER: opener });
    try {
      const opened = await waitForMarker(10_000);
      expect(opened).not.toBeNull();
      expect(opened?.trim()).toContain(`http://127.0.0.1:${viewer.port}`);
      expect(viewer.output()).toContain('Opening your browser');
    } finally {
      await stopViewer(viewer.child);
    }
  }, 60_000);

  it('CODEGRAPH_BROWSER=none suppresses the launch like --no-open', async () => {
    const viewer = await startViewer(['--port', '0', projectDir], { CODEGRAPH_BROWSER: 'none' });
    try {
      expect((await get(viewer.port, '/')).status).toBe(200);
      await vi.waitFor(() => expect(viewer.output()).toContain('Open that URL in a browser'));
      expect(viewer.output()).not.toContain('Opening your browser');
    } finally {
      await stopViewer(viewer.child);
    }
  }, 60_000);

  it('moves off the default port when it is busy', async () => {
    // Occupy 4747 so the fallback has something to fall back FROM. If a
    // developer's own viewer already holds it, the bind fails and the
    // assertion below is still exactly the right one: the new viewer must not
    // be on 4747 either way.
    const blocker = http.createServer(() => {});
    const bound = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(true));
    });

    try {
      const viewer = await startViewer(['--no-open', projectDir], {});
      try {
        expect(viewer.port).not.toBe(DEFAULT_PORT);
        expect((await get(viewer.port, '/')).status).toBe(200);
      } finally {
        await stopViewer(viewer.child);
      }
    } finally {
      if (bound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);

  it('refuses to move off a port the user pinned with --port', async () => {
    const blocker = http.createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const { code, output } = runCli(['ui', '--no-open', '--port', String(taken), projectDir]);
      expect(code).toBe(1);
      expect(output).toContain('already in use');
      expect(output).not.toContain('at Object.');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);

  it('refuses a foreign Host end-to-end', async () => {
    const viewer = await startViewer(['--no-open', '--port', '0', projectDir], {});
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: viewer.port,
            path: '/',
            headers: { Host: 'evil.example' },
            setHost: false,
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('<div id="app">');
    } finally {
      await stopViewer(viewer.child);
    }
  }, 60_000);
});
