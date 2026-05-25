/**
 * Shared MCP daemon — issue #411.
 *
 * Validates the contract added in `src/mcp/{daemon,proxy,session}.ts`:
 *   - Two `serve --mcp` invocations against the same project share *one*
 *     daemon process; the second invocation attaches as a proxy.
 *   - A stale lockfile (PID gone, no socket) gets cleared so the next
 *     invocation can become the new daemon.
 *   - `CODEGRAPH_NO_DAEMON=1` opts out — both processes run independently.
 *   - The proxy refuses to attach across a version mismatch.
 *
 * These tests intentionally spawn real `node dist/bin/codegraph.js` processes
 * over real sockets — the same surface a Claude Code / Cursor / Codex install
 * would exercise. Idle timeouts are forced short via
 * `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` to keep the suite fast.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  // Resolves once the child has emitted at least one stderr line — gives us a
  // stable signal that the process is past the `relaunchWithWasmRuntimeFlagsIfNeeded`
  // re-exec dance.
  spawnedSettled: Promise<void>;
}

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}): SpawnedServer {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  let firstStderrResolve!: () => void;
  const spawnedSettled = new Promise<void>((resolve) => { firstStderrResolve = resolve; });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      stdout.push(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      stderr.push(stderrBuf.slice(0, idx));
      stderrBuf = stderrBuf.slice(idx + 1);
    }
    firstStderrResolve();
  });
  return { child, stdout, stderr, spawnedSettled };
}

function sendInitialize(child: ChildProcessWithoutNullStreams, rootUri: string, id: number = 0) {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri,
    },
  });
  child.stdin.write(msg + '\n');
}

function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  pollMs: number = 25,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v as T);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function findInitializeResponse(stdout: string[], id: number) {
  for (const line of stdout) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === id && parsed.result?.serverInfo) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function killTree(...procs: ChildProcessWithoutNullStreams[]) {
  for (const p of procs) {
    if (!p.killed) {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

async function waitProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

describe('Shared MCP daemon (issue #411)', () => {
  let tempDir: string;
  const servers: SpawnedServer[] = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-daemon-'));
    // Initialize a real CodeGraph project — the daemon needs `.codegraph/` to
    // know where to put its socket + pidfile. `CodeGraph.init` writes the SQL
    // schema synchronously, so by the time we spawn the server it's ready.
    const cg = await CodeGraph.init(tempDir);
    cg.close();
  });

  afterEach(async () => {
    killTree(...servers.map((s) => s.child));
    // Give the OS a moment to reap and remove socket files before rmSync.
    await new Promise((resolve) => setTimeout(resolve, 50));
    servers.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('second invocation attaches as a proxy to the first', async () => {
    // Short idle so the suite doesn't have to wait the production 5 minutes
    // if anything leaks — but long enough that the second client's lifetime
    // overlaps with the daemon's.
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '5000' };

    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    const firstResponse = await waitFor(
      () => findInitializeResponse(first.stdout, 1),
      8000,
    );
    expect(firstResponse.result.serverInfo.name).toBe('codegraph');

    // Daemon should be advertising itself on stderr — proves the daemon path
    // ran, not the direct-mode fallback.
    expect(first.stderr.some((l) => l.includes('[CodeGraph daemon] Listening on'))).toBe(true);

    // Lockfile + socket exist.
    const pidPath = path.join(tempDir, '.codegraph', 'daemon.pid');
    const sockPath = path.join(tempDir, '.codegraph', 'daemon.sock');
    expect(fs.existsSync(pidPath)).toBe(true);
    // On POSIX the socket lives at the in-project path unless its absolute
    // path exceeded the limit — `os.tmpdir()`-based fallback is rare for
    // mkdtemp paths.
    expect(fs.existsSync(sockPath)).toBe(true);

    // Second server in the same project should attach as a proxy.
    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, `file://${tempDir}`, 2);
    const secondResponse = await waitFor(
      () => findInitializeResponse(second.stdout, 2),
      8000,
    );
    expect(secondResponse.result.serverInfo.name).toBe('codegraph');
    // The proxy logs its attach to stderr; that's the canonical witness.
    await waitFor(
      () => second.stderr.some((l) => l.includes('Attached to shared daemon')),
      5000,
    );
  }, 30000);

  it('CODEGRAPH_NO_DAEMON=1 keeps both processes independent (no socket)', async () => {
    const env = { CODEGRAPH_NO_DAEMON: '1' };
    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    await waitFor(() => findInitializeResponse(first.stdout, 1), 8000);
    // Direct mode — no daemon listener log.
    expect(first.stderr.some((l) => l.includes('[CodeGraph daemon] Listening on'))).toBe(false);
    // No pidfile in opt-out mode.
    expect(fs.existsSync(path.join(tempDir, '.codegraph', 'daemon.pid'))).toBe(false);
  }, 20000);

  it('stale pidfile from a dead daemon gets cleared and a fresh daemon takes over', async () => {
    // Plant a lockfile pointing at a definitely-dead pid. PID 999999 is
    // outside the usual Linux pid_max default (4194304) — but `process.kill`
    // probing returns ESRCH for nonexistent pids, which is what we want.
    const pidPath = path.join(tempDir, '.codegraph', 'daemon.pid');
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: 999_999,
        version: '0.0.0-fake',
        socketPath: path.join(tempDir, '.codegraph', 'daemon.sock'),
        startedAt: Date.now() - 1000,
      }),
    );

    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '5000' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    let response: { result?: { serverInfo?: { name: string } } } | null = null;
    try {
      response = await waitFor(() => findInitializeResponse(server.stdout, 1), 8000);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nstderr:\n${server.stderr.join('\n')}\nstdout:\n${server.stdout.join('\n')}`,
      );
    }
    expect(response?.result?.serverInfo?.name).toBe('codegraph');
    // Daemon mode took over.
    await waitFor(
      () => server.stderr.some((l) => l.includes('[CodeGraph daemon] Listening on')),
      8000,
    );
    // Pidfile now reflects a live daemon, not the planted-dead one. (Note:
    // we can't compare to `server.child.pid` directly because the CLI may
    // re-exec itself with `--liftoff-only`; the daemon lives in the
    // grandchild, not the immediate child. What matters is that the pid
    // recorded in the lockfile is *alive*, which the planted 999999 wasn't.)
    const lockBody = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    expect(lockBody.pid).not.toBe(999_999);
    expect(() => process.kill(lockBody.pid, 0)).not.toThrow();
  }, 30000);

  it('proxy falls back to direct mode on daemon version mismatch', async () => {
    // Stand up a daemon at a known socket, then write a hello line with a
    // mismatched version into a *separate* test socket. The probe path
    // doesn't actually need a full daemon — just a peer that produces a
    // hello line. We use a hand-rolled mini-server so this test stays
    // hermetic and doesn't depend on lockfile-aware behavior of the real
    // daemon.
    const net = await import('net');
    const sockPath = path.join(tempDir, '.codegraph', 'daemon.sock');
    // Pre-plant a lockfile pointing at a *live* (this test process) pid so
    // the takeover loop doesn't unlink the lockfile mid-test.
    fs.writeFileSync(
      path.join(tempDir, '.codegraph', 'daemon.pid'),
      JSON.stringify({
        pid: process.pid,
        version: '0.0.0-mismatch',
        socketPath: sockPath,
        startedAt: Date.now(),
      }),
    );
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({ codegraph: '0.0.0-mismatch', pid: 1, socketPath: sockPath, protocol: 1 }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));

    try {
      const server = spawnServer(tempDir);
      servers.push(server);
      sendInitialize(server.child, `file://${tempDir}`, 1);
      // Despite the mismatched-version daemon, the client should still get
      // an initialize response — proxy refuses to attach and we fall back
      // to direct mode.
      const response = await waitFor(
        () => findInitializeResponse(server.stdout, 1),
        8000,
      );
      expect(response.result.serverInfo.name).toBe('codegraph');
      // The version-mismatch fallback message goes to stderr.
      await waitFor(
        () => server.stderr.some((l) => l.includes('version') && l.includes('falling back to direct mode')),
        4000,
      );
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 30000);

  it('daemon idle-times-out after the last client disconnects', async () => {
    // 800ms idle is enough to ride out any post-disconnect grace; with the
    // poll-based unref'd timer it fires quickly. We deliberately don't go
    // below ~500ms because the watcher catch-up sync runs in the background
    // and chowns the event loop briefly during teardown.
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '800' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findInitializeResponse(server.stdout, 1), 8000);
    await waitFor(
      () => server.stderr.some((l) => l.includes('[CodeGraph daemon] Listening on')),
      5000,
    );

    // Close stdin → launcher session drops → no clients → idle timer arms.
    server.child.stdin.end();

    // The daemon should exit on idle. Give it a generous window: idle timer
    // (800ms) + a few seconds slack for engine teardown on a slow CI box.
    const exited = await waitProcessExit(server.child, 8000);
    expect(exited).toBe(true);
    // After exit, lockfile + socket should be cleaned up.
    expect(fs.existsSync(path.join(tempDir, '.codegraph', 'daemon.pid'))).toBe(false);
  }, 30000);
});
