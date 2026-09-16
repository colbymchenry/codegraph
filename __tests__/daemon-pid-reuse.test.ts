// Preserve successful PID-reuse recovery alongside the live-lock guards in #1850.
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
import { CodeGraphPackageVersion } from '../src/mcp/version';

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
    // #618: the daemon-attach log line is now off by default; opt the test
    // harness into it (CODEGRAPH_MCP_LOG_ATTACH=1) so the attach assertions
    // below can still observe a successful attach. A per-test env still wins.
    env: { CODEGRAPH_MCP_LOG_ATTACH: '1', ...process.env, ...env },
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

  it('takes over after SIGKILL even when the stale PID has been reused (#1553)', async () => {
    const env = { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000' };
    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, `file://${tempDir}`, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => countListeningLines(realRoot) >= 1, 10000);
    const killedPid = readLockPid(realRoot)!;

    process.kill(killedPid, 'SIGKILL');
    expect(await waitProcessExit(killedPid, 8000)).toBe(true);

    // Model OS PID reuse without risking another process: the stale lock now
    // names this live vitest worker, but no daemon answers the leftover socket.
    fs.writeFileSync(
      path.join(realRoot, '.codegraph', 'daemon.pid'),
      JSON.stringify({
        pid: process.pid,
        version: CodeGraphPackageVersion,
        socketPath: getDaemonSocketPath(realRoot),
        startedAt: Date.now() - 60_000,
      }),
    );

    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, `file://${tempDir}`, 2);
    const response = await waitFor(() => findResponse(second.stdout, 2), 12000);
    expect(response.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => countListeningLines(realRoot) >= 2, 10000);

    const replacementPid = readLockPid(realRoot)!;
    expect(replacementPid).not.toBe(killedPid);
    expect(replacementPid).not.toBe(process.pid);
    expect(isAlive(replacementPid)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  }, 50000);

});
