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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { once } from 'events';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}, args: string[] = []): SpawnedServer {
  // Record the daemon candidates this launcher spawns, for the teardown.
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp', ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // #618: the daemon-attach log line is now off by default; opt the test
    // harness into it (CODEGRAPH_MCP_LOG_ATTACH=1) so the attach assertions
    // below can still observe a successful attach. A per-test env still wins.
    env: { CODEGRAPH_MCP_LOG_ATTACH: '1', ...process.env, ...recorder.env, ...env },
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
  label = '',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v: T | undefined | null | false;
      try { v = predicate(); } catch (e) { return reject(e); }
      if (v) return resolve(v as T);
      if (Date.now() - started > timeoutMs) {
        // Name the wait: an async stack loses the await site, so an unlabeled
        // timeout can't tell WHICH step flaked (the #662 test's recurring
        // timeout was undiagnosable for exactly this reason).
        return reject(new Error(`Timed out after ${timeoutMs}ms${label ? ` waiting for: ${label}` : ''}`));
      }
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

async function staleIndex(root: string): Promise<Buffer> {
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() {}\n');
  const cg = CodeGraph.openSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
  const before = fs.readFileSync(path.join(root, '.codegraph', 'codegraph.db'));
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function changedSymbol() {}\n');
  return before;
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
    // The runtime flags avoid an intermediate relaunch process. Wait for each
    // actual server to exit before removing its Windows working directory.
    await Promise.all(servers.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    // Racing launchers may each have spawned a daemon candidate, and a loser
    // can still be starting on a loaded machine. Stopping the winner first
    // would let it take over the fixture being removed (#1773).
    await settleLosingCandidates(tempDir, () => readLockPid(realRoot));
    // The daemon is detached (not a tracked child) — reap it explicitly via the
    // pid it recorded, so a test can't leak a background daemon. Guard against
    // our own pid: the version-mismatch test plants `pid: process.pid` in the
    // lockfile, and we must never SIGKILL the vitest worker.
    const daemonPid = readLockPid(realRoot);
    if (daemonPid && daemonPid !== process.pid && isAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* race */ }
      await waitProcessExit(daemonPid, 5000);
    }
    await new Promise((r) => setTimeout(r, 50));
    servers.length = 0;
    removeSpawnLog(tempDir);
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 45_000);

  it.runIf(process.platform !== 'win32')('stops despite a socket still waiting for its client hello (#1963)', async () => {
    const server = spawnServer(tempDir);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    // The lock is written before the socket is bound; an attached proxy proves
    // the daemon is listening (#1773).
    await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
    const pid = await waitFor(() => readLockPid(realRoot), 10000);
    const raw = net.connect(getDaemonSocketPath(realRoot));
    try {
      await new Promise<void>((resolve, reject) => {
        raw.once('data', () => resolve());
        raw.once('error', reject);
      });
      process.kill(pid, 'SIGTERM');
      expect(await waitProcessExit(pid, 1500)).toBe(true);
      expect(fs.existsSync(path.join(realRoot, '.codegraph', 'writer.pid'))).toBe(false);
    } finally {
      raw.destroy();
    }
  }, 20000);

  it('a disconnect before client hello leaves no phantom session and the idle reaper exits (#1356)', async () => {
    const server = spawnServer(tempDir, {
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '800',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
      CODEGRAPH_DAEMON_CLIENT_SWEEP_MS: '0',
    });
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
    const pid = await waitFor(() => readLockPid(realRoot), 10000);
    const raw = net.connect(getDaemonSocketPath(realRoot));
    try {
      await new Promise<void>((resolve, reject) => {
        raw.once('data', () => resolve());
        raw.once('error', reject);
      });
      raw.destroy();
      server.child.stdin.end();
      expect(await waitProcessExit(pid, 8000)).toBe(true);
      expect(readDaemonLog(realRoot)).toContain('Shutting down (idle timeout; clients=0)');
      expect(fs.existsSync(path.join(realRoot, '.codegraph', 'writer.pid'))).toBe(false);
    } finally { raw.destroy(); }
  }, 20000);

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

  it.each(['2', '0'])('direct stdio honors query pool size=%s and exits after concurrent reads', async (size) => {
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function directSymbol() { return 42; }\n');
    const cg = await CodeGraph.open(tempDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    const server = spawnServer(tempDir, {
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_QUERY_POOL_SIZE: size,
    }, ['--no-watch', '--path', tempDir]);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((l) => l.includes(size === '0'
      ? 'Query pool disabled' : 'Query pool: up to 2 worker thread(s)')), 10000, 25, 'direct query pool configuration');
    const ids = [2, 3, 4, 5, 6, 7];
    for (const id of ids) {
      sendMessage(server.child, {
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'codegraph_explore', arguments: { query: 'directSymbol' } },
      });
    }
    const replies = await Promise.all(ids.map((id) => waitFor(() => findResponse(server.stdout, id), 15000)));
    for (const reply of replies) {
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).toBeFalsy();
      expect(reply.result.content[0].text).toContain('directSymbol');
      expect(reply.result).not.toHaveProperty('_cgExploreEmission');
    }
    const exited = new Promise<number | null>((resolve) => server.child.once('exit', resolve));
    server.child.stdin.end();
    expect(await exited).toBe(0);
  }, 30000);

  it('direct stdio queries multiple projects without a default index', async () => {
    fs.rmSync(path.join(tempDir, '.codegraph'), { recursive: true, force: true });
    for (const name of ['alpha', 'beta']) {
      const root = path.join(tempDir, name);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'app.ts'), `export function ${name}Symbol() { return 42; }\n`);
      const cg = await CodeGraph.init(root);
      try { await cg.indexAll(); } finally { cg.close(); }
    }
    const server = spawnServer(tempDir, {
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_QUERY_POOL_SIZE: '2',
    }, ['--no-watch', '--path', tempDir]);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((l) => l.includes('Query pool: up to 2')), 10000);
    for (const [i, name] of ['alpha', 'beta'].entries()) {
      sendMessage(server.child, {
        jsonrpc: '2.0', id: i + 2, method: 'tools/call',
        params: { name: 'codegraph_explore', arguments: { query: `${name}Symbol`, projectPath: path.join(tempDir, name) } },
      });
    }
    for (const [i, name] of ['alpha', 'beta'].entries()) {
      const reply = await waitFor(() => findResponse(server.stdout, i + 2), 15000);
      expect(reply.result.isError).toBeFalsy();
      expect(reply.result.content[0].text).toContain(`${name}Symbol`);
    }
    sendMessage(server.child, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'alphaSymbol' } },
    });
    const missing = await waitFor(() => findResponse(server.stdout, 4), 10000);
    expect(missing.result.isError).toBeFalsy();
    expect(missing.result.content[0].text).toContain('projectPath');
    expect(fs.existsSync(path.join(tempDir, '.codegraph'))).toBe(false);
  }, 30000);

  it('proxy fallback enables the query pool when no live writer holds the project', async () => {
    const net = await import('net');
    const sockPath = getDaemonSocketPath(realRoot);
    const miniServer = net.createServer((sock) => {
      sock.end(JSON.stringify({
        codegraph: '0.0.0-mismatch', pid: process.pid, socketPath: sockPath, protocol: 1,
      }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, resolve));
    try {
      const server = spawnServer(tempDir, { CODEGRAPH_QUERY_POOL_SIZE: '2' }, ['--no-watch']);
      servers.push(server);
      sendInitialize(server.child, `file://${tempDir}`, 1);
      await waitFor(() => findResponse(server.stdout, 1), 10000);
      sendMessage(server.child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'codegraph_files', arguments: {} },
      });
      const reply = await waitFor(() => findResponse(server.stdout, 2), 10000);
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).toBeFalsy();
      expect(server.stderr.some((l) => l.includes('serving this session in-process'))).toBe(true);
      expect(server.stderr.some((l) => l.includes('Query pool: up to 2'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 30000);

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

  it('preserves paired daemon/writer locks when their live PID may have been reused', async () => {
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000' };
    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => countListeningLines(realRoot) >= 1, 10000);
    // Listening precedes engine initialization. Do not kill SQLite while its
    // initial connection is still being configured for this fixture.
    sendMessage(first.child, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const ready = await waitFor(() => findResponse(first.stdout, 10), 10000);
    expect(ready.result?.isError).not.toBe(true);
    expect(JSON.stringify(ready.result)).toContain('CodeGraph Status');
    const killedPid = readLockPid(realRoot)!;

    // End the first proxy before simulating PID reuse. Otherwise it can switch
    // to a fallback writer while this test prepares the replacement locks/DB.
    first.child.stdin.end();
    await waitFor(() => first.child.exitCode !== null, 5000);
    process.kill(killedPid, 'SIGKILL');
    expect(await waitProcessExit(killedPid, 8000)).toBe(true);

    // Model OS PID reuse without risking another process: the stale lock now
    // names this live vitest worker, but no daemon answers the leftover socket.
    const daemonPath = path.join(realRoot, '.codegraph', 'daemon.pid');
    const writerPath = path.join(realRoot, '.codegraph', 'writer.pid');
    const staleDaemonLock = JSON.stringify({
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath: getDaemonSocketPath(realRoot),
      startedAt: Date.now() - 60_000,
    });
    const staleWriterLock = JSON.stringify({
      pid: process.pid,
      mode: 'daemon',
      startedAt: Date.now() - 60_000,
    }) + '\n';
    fs.writeFileSync(daemonPath, staleDaemonLock);
    fs.writeFileSync(writerPath, staleWriterLock);

    // Make the index stale by changing the source, without opening a new
    // SQLite writer against the database of the daemon we just killed.
    const before = fs.readFileSync(path.join(realRoot, '.codegraph', 'codegraph.db'));
    fs.writeFileSync(path.join(realRoot, 'app.ts'), 'export function changedSymbol() {}\n');
    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, `file://${tempDir}`, 2);
    const response = await waitFor(() => findResponse(second.stdout, 2), 12000);
    expect(response.result.serverInfo.name).toBe('codegraph');
    await waitFor(
      () => second.stderr.some((line) =>
        line.includes('Attached to shared daemon') || line.includes('Shared daemon unavailable')
      ),
      30000, // The nominal 6s retry loop takes up to 26s on the Windows VM.
      25,
      'the proxy to attach or fall back',
    );

    expect(second.stderr.some((line) => line.includes('Attached to shared daemon'))).toBe(false);
    expect(countListeningLines(realRoot)).toBe(1);
    expect(fs.readFileSync(daemonPath, 'utf8')).toBe(staleDaemonLock);
    expect(fs.readFileSync(writerPath, 'utf8')).toBe(staleWriterLock);
    expect(isAlive(process.pid)).toBe(true);

    sendMessage(second.child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const toolResponse = await waitFor(() => findResponse(second.stdout, 3), 5000);
    expect(toolResponse.error).toBeUndefined();
    expect(toolResponse.result?.isError).not.toBe(true);
    expect(JSON.stringify(toolResponse.result)).toContain('CodeGraph Status');
    expect(second.stderr.some((line) => line.includes('Serving reads in-process without auto-sync'))).toBe(true);
    second.child.stdin.end();
    await waitFor(() => second.child.exitCode !== null, 5000);
    expect(fs.readFileSync(path.join(realRoot, '.codegraph', 'codegraph.db'))).toEqual(before);
    expect(fs.readFileSync(writerPath, 'utf8')).toBe(staleWriterLock);
  }, 50000);

  it('does not replace a live legacy lock with a second daemon', async () => {
    const pidPath = path.join(realRoot, '.codegraph', 'daemon.pid');
    fs.writeFileSync(pidPath, `${process.pid}\n`);

    const server = spawnServer(tempDir, { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000' });
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    const response = await waitFor(() => findResponse(server.stdout, 1), 12000);
    expect(response.result.serverInfo.name).toBe('codegraph');

    await waitFor(
      () => server.stderr.some((line) =>
        line.includes('Attached to shared daemon') || line.includes('Shared daemon unavailable')
      ),
      30000, // The nominal 6s retry loop takes up to 26s on the Windows VM.
      25,
      'the proxy to attach or fall back',
    );

    expect(server.stderr.some((line) => line.includes('Attached to shared daemon'))).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(`${process.pid}\n`);
    expect(countListeningLines(realRoot)).toBe(0);
    expect(isAlive(process.pid)).toBe(true);

    sendMessage(server.child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const toolResponse = await waitFor(() => findResponse(server.stdout, 2), 5000);
    expect(toolResponse).toMatchObject({
      error: { message: expect.stringContaining('live legacy daemon') },
    });
  }, 40000);

  it('does not start a fallback writer when the daemon lock is unreadable', async () => {
    const pidPath = path.join(realRoot, '.codegraph', 'daemon.pid');
    fs.mkdirSync(pidPath);

    const server = spawnServer(tempDir);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(
      () => server.stderr.some((line) => line.includes('Shared daemon unavailable')),
      30000, // The nominal 6s retry loop takes up to 26s on the Windows VM.
      25,
      'the proxy to fall back',
    );

    sendMessage(server.child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const toolResponse = await waitFor(() => findResponse(server.stdout, 2), 5000);
    expect(toolResponse).toMatchObject({
      error: { message: expect.stringContaining('daemon lock could not be read') },
    });
  }, 40000);

  it.each([null, 'daemon', 'fallback'])('proxy falls back to read-only mode on a daemon version mismatch (writer: %s)', async (mode) => {
    const before = await staleIndex(realRoot);
    const writerPath = path.join(realRoot, '.codegraph', 'writer.pid');
    const writer = JSON.stringify({ pid: process.pid, mode, startedAt: Date.now() });
    if (mode) fs.writeFileSync(writerPath, writer);
    const net = await import('net');
    const sockPath = getDaemonSocketPath(realRoot);
    // Plant a live-pid lockfile so the launcher treats the lock as held, and a
    // mini-server that answers with a mismatched-version hello.
    fs.writeFileSync(
      path.join(realRoot, '.codegraph', 'daemon.pid'),
      JSON.stringify({ pid: process.pid, version: '0.0.0-mismatch', socketPath: sockPath, startedAt: Date.now() }),
    );
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({
        codegraph: '0.0.0-mismatch',
        pid: process.pid,
        socketPath: sockPath,
        protocol: 1,
      }) + '\n');
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

      sendMessage(server.child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'codegraph_status', arguments: {} },
      });
      const toolResponse = await waitFor(() => findResponse(server.stdout, 2), 5000);
      expect(toolResponse.error).toBeUndefined();
      expect(toolResponse.result?.isError).not.toBe(true);
      expect(JSON.stringify(toolResponse.result)).toContain('CodeGraph Status');
      expect(fs.existsSync(writerPath)).toBe(mode !== null);
      expect(server.stderr.some((l) => l.includes('Serving reads in-process without auto-sync:'))).toBe(true);
      server.child.stdin.end();
      await waitFor(() => server.child.exitCode !== null, 5000);
      expect(fs.readFileSync(path.join(realRoot, '.codegraph', 'codegraph.db'))).toEqual(before);
      expect(readLockPid(realRoot)).toBe(process.pid);
      if (mode) expect(fs.readFileSync(writerPath, 'utf8')).toBe(writer);
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 30000);

  // The over-the-wire client-hello → record → sweep path, and the inactivity
  // backstop's liveness gate, are covered by the deterministic unit tests in
  // daemon-client-liveness (`reapDeadClients`, `backstopShouldExit`) — a
  // raw-socket variant here was flaky under heavy parallel load. What stays
  // here is the lifecycle behavior that needs real procs: a live-but-quiet
  // client must SURVIVE the inactivity backstop. Reaping it used to silently
  // degrade the session (and any others sharing the daemon) to an in-process
  // engine; on a real machine the backstop fired on live sessions far more
  // often than on the phantoms it exists for. The phantom case it still covers
  // (an unknown-pid connection) is the `backstopShouldExit` unit test.
  it('does NOT reap a live-but-quiet client on the inactivity backstop (#692)', async () => {
    // Backstop short, idle timeout long: with a client connected the idle timer
    // never arms, so the inactivity backstop is the only thing that could take
    // the daemon down — and it must not, because the client's peer is alive.
    const env = { CODEGRAPH_DAEMON_MAX_IDLE_MS: '1200', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '60000' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    // initialize is answered locally, and a PID file can belong to a daemon
    // still starting. Establish a real live session before measuring silence.
    const attached = await waitFor(
      () => server.stderr.find((line) => line.includes('Attached to shared daemon')),
      10000,
    );
    sendMessage(server.child, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const status = await waitFor(() => findResponse(server.stdout, 2), 10000);
    expect(status.error).toBeUndefined();
    expect(status.result?.isError).not.toBe(true);
    expect(JSON.stringify(status.result)).toContain('CodeGraph Status');
    const daemonPid = readLockPid(realRoot)!;
    expect(attached).toContain(`(pid ${daemonPid},`);
    expect(isAlive(daemonPid)).toBe(true);

    // Stay silent well past several backstop windows. The live session's peer is
    // provably alive, so the daemon must keep running (and never log a backstop
    // shutdown), with its lockfile intact.
    await new Promise((r) => setTimeout(r, 4000)); // > 3× maxIdle
    expect(isAlive(daemonPid), readDaemonLog(realRoot) + '\n' + server.stderr.join('\n')).toBe(true);
    expect(readDaemonLog(realRoot)).not.toContain('inactivity backstop');
    expect(readLockPid(realRoot)).toBe(daemonPid);
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

  it('proxy survives the daemon dying mid-session and keeps serving (#662)', async () => {
    // The #662 scenario: an MCP host SIGTERM's the shared daemon while a session
    // is live. The proxy must NOT exit (losing CodeGraph for that session) — it
    // falls back to an in-process engine and keeps answering.
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000', CODEGRAPH_PPID_POLL_MS: '5000' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(server.stdout, 1), 20000, 25, 'initialize response');
    await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 8000, 25, 'daemon attach log');
    await waitFor(() => (readLockPid(realRoot) ?? 0) > 0, 8000, 25, 'daemon pidfile');
    const daemonPid = readLockPid(realRoot)!;

    // A warm call goes through the daemon.
    sendMessage(server.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    try {
      await waitFor(() => findResponse(server.stdout, 2), 30000, 25, 'warm tools/call via daemon');
    } catch (e) {
      // This is the wait that historically flaked — surface WHERE the request
      // died: proxy side (stderr) or daemon side (daemon.log).
      let daemonLog = '<no daemon.log>';
      try { daemonLog = fs.readFileSync(path.join(realRoot, '.codegraph', 'daemon.log'), 'utf8').split('\n').slice(-25).join('\n'); } catch { /* absent */ }
      throw new Error(
        `${(e as Error).message}\ndaemonAlive=${isAlive(daemonPid)} proxyAlive=${isAlive(server.child.pid!)}\n` +
        `--- proxy stderr tail ---\n${server.stderr.slice(-15).join('')}\n--- daemon.log tail ---\n${daemonLog}`
      );
    }

    // Kill the daemon out from under the live proxy.
    process.kill(daemonPid, 'SIGTERM');
    expect(await waitProcessExit(daemonPid, 8000)).toBe(true);

    // The proxy must still be alive and still answer — served in-process now.
    expect(isAlive(server.child.pid!)).toBe(true);
    await waitFor(() => server.stderr.some((l) => l.includes('serving this session in-process')), 8000, 25, 'in-process failover log');
    sendMessage(server.child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const resp = await waitFor(() => findResponse(server.stdout, 3), 15000);
    expect(resp.result !== undefined || resp.error !== undefined).toBe(true);
    expect(isAlive(server.child.pid!)).toBe(true);
  }, 45000);

  it('a proxy serving in-process hands the writer lock back to a fresh daemon (#2277)', async () => {
    // After its daemon dies, the proxy's in-process engine takes writer.pid in
    // fallback mode. Every later daemon start used to fail on that lock for the
    // rest of the session, so every other session on the project ran read-only
    // without auto-sync. The degraded proxy now retries the daemon: it stops
    // its engine (releasing the lock), lets a daemon start, and proxies again.
    const env = {
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000',
      CODEGRAPH_PPID_POLL_MS: '5000',
      // The default, spelled out: long enough to observe the lockout first.
      CODEGRAPH_DAEMON_RETRY_MS: '5000',
    };
    const a = spawnServer(tempDir, env);
    servers.push(a);
    const proxyPid = a.child.pid!;
    sendInitialize(a.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(a.stdout, 1), 20000, 25, 'initialize response');
    await waitFor(() => a.stderr.some((l) => l.includes('Attached to shared daemon')), 8000, 25, 'first daemon attach');
    sendMessage(a.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    await waitFor(() => findResponse(a.stdout, 2), 30000, 25, 'warm tools/call via daemon');
    const firstDaemon = readLockPid(realRoot)!;

    process.kill(firstDaemon, 'SIGTERM');
    expect(await waitProcessExit(firstDaemon, 8000)).toBe(true);
    await waitFor(() => a.stderr.some((l) => l.includes('serving this session in-process')), 8000, 25, 'in-process failover');
    sendMessage(a.child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    await waitFor(() => findResponse(a.stdout, 3), 15000, 25, 'in-process tools/call');

    // The lockout: the in-process engine owns the project's writer slot.
    expect(readWriterInfo(realRoot)).toMatchObject({ pid: proxyPid, mode: 'fallback' });

    // Another session starting now cannot get a daemon while that lock is held.
    const b = spawnServer(tempDir, env);
    servers.push(b);
    sendInitialize(b.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(b.stdout, 1), 20000, 25, 'second session initialize');

    // Keep calling through the handover: every request gets exactly one reply.
    let nextId = 4;
    const send = (): void => {
      sendMessage(a.child, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    };
    const ticker = setInterval(send, 250);
    let daemonWriter: { pid: number; mode: string } | null = null;
    try {
      daemonWriter = await waitFor(() => {
        const w = readWriterInfo(realRoot);
        return w && w.mode === 'daemon' && w.pid !== proxyPid && isAlive(w.pid) ? w : null;
      }, 30000, 25, 'a daemon to own the writer lock');
      await waitFor(
        () => a.stderr.some((l) => l.includes(`Attached to shared daemon`) && l.includes(`(pid ${daemonWriter!.pid},`)),
        15000, 25, 'the proxy to reattach to the new daemon',
      );
    } finally {
      clearInterval(ticker);
    }
    send();
    const lastId = nextId - 1;
    await waitFor(() => findResponse(a.stdout, lastId), 15000, 25, 'a tools/call through the new daemon');
    for (let id = 2; id <= lastId; id++) {
      const replies = a.stdout.filter((line) => {
        try { const m = JSON.parse(line); return m.id === id && ('result' in m || 'error' in m); } catch { return false; }
      });
      expect(replies, `replies to request ${id}`).toHaveLength(1);
      expect(JSON.parse(replies[0]).error, `request ${id}`).toBeUndefined();
    }
    expect(readLockPid(realRoot)).toBe(daemonWriter!.pid);

    // The session that started during the lockout ends up on the shared daemon too.
    await waitFor(
      () => b.stderr.some((l) => l.includes('Attached to shared daemon') && l.includes(`(pid ${daemonWriter!.pid},`)),
      30000, 25, 'the second session to attach',
    );
    sendMessage(b.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const bReply = await waitFor(() => findResponse(b.stdout, 2), 15000, 25, 'second session tools/call');
    expect(bReply.error).toBeUndefined();
  }, 90000);

  it('a read-only in-process session moves to the shared daemon once one can start (#2277)', async () => {
    // A session that fell back read-only (another daemon held the project)
    // used to stay that way for life. Once the blocker is gone it now starts
    // and attaches to a daemon of its own version.
    const sockPath = getDaemonSocketPath(realRoot);
    const pidPath = path.join(realRoot, '.codegraph', 'daemon.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, version: '0.0.0-mismatch', socketPath: sockPath, startedAt: Date.now() }));
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({ codegraph: '0.0.0-mismatch', pid: process.pid, socketPath: sockPath, protocol: 1 }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));
    let miniServerOpen = true;
    try {
      const server = spawnServer(tempDir, {
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000',
        CODEGRAPH_DAEMON_RETRY_MS: '300',
        CODEGRAPH_DAEMON_RETRY_MAX_MS: '1000',
      });
      servers.push(server);
      sendInitialize(server.child, `file://${tempDir}`, 1);
      await waitFor(() => server.stderr.some((l) => l.includes('serving this session in-process')), 10000, 25, 'in-process fallback');
      sendMessage(server.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
      const local = await waitFor(() => findResponse(server.stdout, 2), 10000, 25, 'read-only tools/call');
      expect(local.error).toBeUndefined();
      expect(server.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
      // Retries while the other version still answers start no daemon.
      await waitFor(
        () => server.stderr.filter((l) => l.includes('differs from ours')).length >= 3,
        10000, 25, 'repeated retries against the other version',
      );
      expect(countListeningLines(realRoot)).toBe(0);

      // The other-version daemon goes away.
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
      miniServerOpen = false;
      fs.rmSync(pidPath, { force: true });

      const attached = await waitFor(
        () => server.stderr.find((l) => l.includes('Attached to shared daemon')),
        30000, 25, 'the session to attach to a daemon',
      );
      const daemonPid = readLockPid(realRoot)!;
      expect(attached).toContain(`(pid ${daemonPid},`);
      expect(readWriterInfo(realRoot)).toMatchObject({ pid: daemonPid, mode: 'daemon' });
      sendMessage(server.child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
      const viaDaemon = await waitFor(() => findResponse(server.stdout, 3), 15000, 25, 'tools/call through the daemon');
      expect(viaDaemon.error).toBeUndefined();
      expect(JSON.stringify(viaDaemon.result)).toContain('CodeGraph Status');
    } finally {
      if (miniServerOpen) await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 60000);
});

function readWriterInfo(root: string): { pid: number; mode: string } | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'writer.pid'), 'utf8'));
    return typeof info.pid === 'number' && typeof info.mode === 'string' ? info : null;
  } catch { return null; }
}
