/**
 * Shared MCP daemon — issue #411.
 *
 * Validates the daemon architecture in `src/mcp/{daemon,proxy,session,index}.ts`
 * AFTER the review fixes:
 *
 *   - The daemon is a *detached* background process; every `serve --mcp`
 *     invocation is a thin proxy to it. Two invocations against one project
 *     share ONE daemon.
 *   - Concurrent launchers converge on a single daemon (the must-fix-1
 *     lockfile-race: an empty-pidfile window used to let a racing candidate
 *     delete the winner's lock → two daemons).
 *   - Killing the launcher that spawned the daemon does NOT take the daemon
 *     down — other attached clients keep working (the must-fix-2 detach: the
 *     in-process daemon used to die with its launcher's process group and
 *     orphan on host SIGKILL, regressing #277).
 *   - A stale lockfile (dead pid) is cleared; `CODEGRAPH_NO_DAEMON=1` opts out;
 *     the proxy refuses to attach across a version mismatch; the daemon
 *     idle-times-out after the last client leaves (so a single session can't
 *     leak a daemon forever).
 *
 * These tests intentionally spawn real `node dist/bin/codegraph.js` processes
 * over real sockets/pipes — the same surface a Claude Code / Cursor / Codex
 * install exercises. The daemon logs to `.codegraph/daemon.log` (it has no
 * client stderr of its own), so daemon-side assertions read that file.
 *
 * `realRoot` vs `tempDir`: processes are spawned with the (possibly symlinked)
 * `tempDir` as cwd/rootUri — on macOS `os.tmpdir()` lives under `/var`, a
 * symlink to `/private/var`, and a spawned child's `process.cwd()` is already
 * realpath'd. The daemon canonicalizes the root with `realpathSync`, so all
 * path assertions use `realRoot` (the canonical form). That this matches end to
 * end is itself the proof the canonicalization works.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}): SpawnedServer {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  // Swallow spawn/EPIPE errors so killing a child mid-write can't surface as an
  // unhandled error that crashes the vitest worker.
  child.on('error', () => { /* ignore */ });
  child.stdin.on('error', () => { /* ignore */ });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
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
  });
  return { child, stdout, stderr };
}

function sendMessage(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child may be gone */ }
}

function sendInitialize(child: ChildProcessWithoutNullStreams, rootUri: string, id: number): void {
  sendMessage(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri,
    },
  });
}

/** Find a JSON-RPC response with the given id (result OR error) on stdout. */
function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  pollMs = 25,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v: T | undefined | null | false;
      try { v = predicate(); } catch (e) { return reject(e); }
      if (v) return resolve(v as T);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out after ${timeoutMs}ms`));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLockPid(root: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8');
    const info = JSON.parse(raw);
    return typeof info.pid === 'number' ? info.pid : null;
  } catch { return null; }
}

function readDaemonLog(root: string): string {
  try { return fs.readFileSync(path.join(root, '.codegraph', 'daemon.log'), 'utf8'); }
  catch { return ''; }
}

function countListeningLines(root: string): number {
  return readDaemonLog(root).split('\n').filter((l) => l.includes('[CodeGraph daemon] Listening on')).length;
}

function killTree(...procs: ChildProcessWithoutNullStreams[]): void {
  for (const p of procs) {
    if (!p.killed) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs).then(() => true).catch(() => false);
}

describe('Shared MCP daemon (issue #411)', () => {
  let tempDir: string;   // the (possibly symlinked) path processes are spawned with
  let realRoot: string;  // its canonical form — what the daemon keys paths on
  const servers: SpawnedServer[] = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-daemon-'));
    const cg = await CodeGraph.init(tempDir);
    cg.close();
    realRoot = fs.realpathSync(tempDir);
  });

  afterEach(async () => {
    killTree(...servers.map((s) => s.child));
    // The daemon is detached (not a tracked child) — reap it explicitly via the
    // pid it recorded, so a test can't leak a background daemon. Guard against
    // our own pid: the version-mismatch test plants `pid: process.pid` in the
    // lockfile, and we must never SIGKILL the vitest worker.
    const daemonPid = readLockPid(realRoot);
    if (daemonPid && daemonPid !== process.pid && isAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* race */ }
    }
    await new Promise((r) => setTimeout(r, 50));
    servers.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('two invocations share ONE detached daemon; both attach as proxies', async () => {
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000' };

    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    const firstResp = await waitFor(() => findResponse(first.stdout, 1), 10000);
    expect(firstResp.result.serverInfo.name).toBe('codegraph');

    // The launcher is a PROXY (not the daemon itself) — that's the detach fix.
    await waitFor(() => first.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // A detached daemon came up and recorded itself.
    await waitFor(() => fs.existsSync(path.join(realRoot, '.codegraph', 'daemon.pid')), 8000);
    await waitFor(() => countListeningLines(realRoot) >= 1, 8000);
    const daemonPid = readLockPid(realRoot);
    expect(daemonPid).toBeTruthy();
    expect(isAlive(daemonPid!)).toBe(true);
    // The socket exists at the path the code computes from the canonical root.
    // On Windows the daemon listens on a named pipe (\\.\pipe\...), which isn't
    // a filesystem entry — existsSync doesn't apply there, and the "Attached to
    // shared daemon" proof above already confirms the proxy reached it.
    if (process.platform !== 'win32') {
      expect(fs.existsSync(getDaemonSocketPath(realRoot))).toBe(true);
    }

    // Second invocation attaches as a proxy to the SAME daemon.
    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, `file://${tempDir}`, 2);
    const secondResp = await waitFor(() => findResponse(second.stdout, 2), 10000);
    expect(secondResp.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => second.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // Exactly one daemon ever bound, and it's the same pid both attached to.
    expect(countListeningLines(realRoot)).toBe(1);
    expect(readLockPid(realRoot)).toBe(daemonPid);
  }, 40000);

  it('concurrent launchers converge on a single daemon (lockfile race — must-fix 1)', async () => {
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000' };

    // Fire three launchers as close to simultaneously as possible — this is the
    // race window where the old code could end up with two daemons.
    const procs = [spawnServer(tempDir, env), spawnServer(tempDir, env), spawnServer(tempDir, env)];
    procs.forEach((p, i) => { servers.push(p); sendInitialize(p.child, `file://${tempDir}`, i + 1); });

    // All three get a valid initialize response...
    for (let i = 0; i < procs.length; i++) {
      const resp = await waitFor(() => findResponse(procs[i].stdout, i + 1), 12000);
      expect(resp.result.serverInfo.name).toBe('codegraph');
    }
    // ...and all three attached as proxies (none fell back / wedged).
    for (const p of procs) {
      await waitFor(() => p.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
    }

    // The decisive assertion: exactly ONE daemon bound the socket. Losing
    // candidates log "already holds the lock; exiting" and never listen.
    expect(countListeningLines(realRoot)).toBe(1);
    const daemonPid = readLockPid(realRoot);
    expect(daemonPid).toBeTruthy();
    expect(isAlive(daemonPid!)).toBe(true);
  }, 45000);

  it('daemon survives the first client dying; a second client keeps working (must-fix 2 / #277)', async () => {
    // Idle high so the daemon doesn't reap mid-test; poll fast so proxy 1
    // notices its dead parent quickly.
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000', CODEGRAPH_PPID_POLL_MS: '200' };

    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => (readLockPid(realRoot) ?? 0) > 0, 8000);
    const daemonPid = readLockPid(realRoot)!;
    expect(isAlive(daemonPid)).toBe(true);

    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(second.stdout, 1), 10000);
    await waitFor(() => second.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // Kill the launcher that spawned the daemon. With the old in-process design
    // this would take the daemon (and thus the second client) down.
    killTree(first.child);

    // The daemon is detached — it must still be alive a beat later.
    await new Promise((r) => setTimeout(r, 1500));
    expect(isAlive(daemonPid)).toBe(true);

    // And the second client can still drive a real tool call through it.
    sendMessage(second.child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolsResp = await waitFor(() => findResponse(second.stdout, 2), 10000);
    expect(Array.isArray(toolsResp.result.tools)).toBe(true);
    expect(toolsResp.result.tools.length).toBeGreaterThan(0);
  }, 45000);

  it('CODEGRAPH_NO_DAEMON=1 keeps each process independent (no socket/pidfile)', async () => {
    const env = { CODEGRAPH_NO_DAEMON: '1' };
    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    // Direct mode — no daemon machinery touched.
    expect(first.stderr.some((l) => l.includes('Attached to shared daemon'))).toBe(false);
    expect(fs.existsSync(path.join(realRoot, '.codegraph', 'daemon.pid'))).toBe(false);
    expect(fs.existsSync(path.join(realRoot, '.codegraph', 'daemon.log'))).toBe(false);
  }, 20000);

  it('clears a stale (dead-pid) lockfile and a fresh daemon takes over', async () => {
    // Plant a lockfile pointing at a definitely-dead pid + the real socket path.
    fs.writeFileSync(
      path.join(realRoot, '.codegraph', 'daemon.pid'),
      JSON.stringify({
        pid: 999_999,
        version: '0.0.0-fake',
        socketPath: getDaemonSocketPath(realRoot),
        startedAt: Date.now() - 1000,
      }),
    );

    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    const resp = await waitFor(() => findResponse(server.stdout, 1), 10000).catch((e) => {
      throw new Error(`${(e as Error).message}\nstderr:\n${server.stderr.join('\n')}\ndaemon.log:\n${readDaemonLog(realRoot)}`);
    });
    expect(resp.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => countListeningLines(realRoot) >= 1, 10000);
    // The pidfile now names a live daemon, not the planted-dead 999999.
    const livePid = readLockPid(realRoot);
    expect(livePid).not.toBe(999_999);
    expect(isAlive(livePid!)).toBe(true);
  }, 40000);

  it('proxy falls back to direct mode on a daemon version mismatch', async () => {
    const net = await import('net');
    const sockPath = getDaemonSocketPath(realRoot);
    // Plant a live-pid lockfile so the launcher treats the lock as held, and a
    // mini-server that answers with a mismatched-version hello.
    fs.writeFileSync(
      path.join(realRoot, '.codegraph', 'daemon.pid'),
      JSON.stringify({ pid: process.pid, version: '0.0.0-mismatch', socketPath: sockPath, startedAt: Date.now() }),
    );
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({ codegraph: '0.0.0-mismatch', pid: 1, socketPath: sockPath, protocol: 1 }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));

    try {
      const server = spawnServer(tempDir);
      servers.push(server);
      sendInitialize(server.child, `file://${tempDir}`, 1);
      // Despite the mismatched daemon, the client still gets an initialize
      // response — the proxy answers the handshake locally and, refusing to
      // attach across the version mismatch, serves the session in-process.
      const resp = await waitFor(() => findResponse(server.stdout, 1), 10000);
      expect(resp.result.serverInfo.name).toBe('codegraph');
      await waitFor(
        () => server.stderr.some((l) => l.includes('serving this session in-process')),
        6000,
      );
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 30000);

  it('daemon idle-times-out after the last client disconnects', async () => {
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '800', CODEGRAPH_PPID_POLL_MS: '200' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => (readLockPid(realRoot) ?? 0) > 0, 8000);
    const daemonPid = readLockPid(realRoot)!;

    // Close the only client's stdin → proxy exits → daemon refcount hits 0 →
    // idle timer fires → daemon exits and cleans up its lockfile.
    server.child.stdin.end();

    expect(await waitProcessExit(daemonPid, 10000)).toBe(true);
    expect(fs.existsSync(path.join(realRoot, '.codegraph', 'daemon.pid'))).toBe(false);
  }, 30000);
});
