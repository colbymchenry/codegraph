/**
 * Startup-orphan regression tests (#1185) — spawn-level.
 *
 * Reproduced bug: an MCP host kills the launcher chain within the server's
 * first ~100ms while keeping the stdio pipes open (config probe, instant
 * cancel, initialize-timeout teardown; Rust hosts that kill a child without
 * dropping its stdio handles hold pipes exactly like this). The server booted
 * already reparented, so its PPID-watchdog baseline read 1 (blind forever),
 * stdin never EOF'd, and the process lived until the HOST exited — one ~30MB
 * node process leaked per occurrence.
 *
 * These tests exercise the last-resort defense end-to-end on the real built
 * binary: a server that receives no MCP traffic shuts itself down when the
 * startup-handshake timeout lapses, and a server that got even one message
 * is never touched by it.
 *
 * POSIX-only: the blind spot is a POSIX reparenting artifact (Windows never
 * reparents, so its liveness-based check keeps working with a late baseline),
 * and the suite avoids the known Windows EPERM teardown quirk of spawned
 * `serve --mcp` children holding the temp cwd open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string, handshakeTimeoutMs: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Direct mode: hermetic (no detached daemon to leak from the suite).
      // The backstop is armed identically on the proxy path.
      CODEGRAPH_NO_DAEMON: '1',
      // Single process (skip the --liftoff-only re-exec) so exit-code and
      // liveness assertions observe the server itself.
      CODEGRAPH_WASM_RELAUNCHED: '1',
      // One less helper child; the liveness watchdog is not under test.
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: String(handshakeTimeoutMs),
    },
  }) as ChildProcessWithoutNullStreams;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const timer = setTimeout(
      () => reject(new Error(`server did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform === 'win32')('startup-orphan backstop (#1185)', () => {
  let dir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphan-'));
  });

  afterEach(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a server that never receives MCP traffic shuts itself down', async () => {
    child = spawnServer(dir, 1000);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    // Keep our pipe ends open the whole time — the abandoned-launch shape:
    // no stdin EOF ever arrives; only the backstop can reap the server.
    const code = await waitForExit(child, 15_000);
    expect(code).toBe(0);
    expect(stderr).toContain('No MCP traffic since startup');
  }, 20_000);

  it('a server that got an initialize is never reaped by the backstop', async () => {
    child = spawnServer(dir, 1000);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n');

    // Well past the 1s backstop window: the first byte disarmed it for good.
    await sleep(3000);
    expect(child.exitCode).toBeNull();

    // Normal lifecycle still intact: closing stdin ends the session.
    child.stdin.end();
    const code = await waitForExit(child, 10_000);
    expect(code).toBe(0);
  }, 20_000);
});
