/**
 * A launcher replaces a daemon from an older install (#2335).
 *
 * A daemon keeps running the code it started with. The 1.6.1 daemon in #2335
 * outlived an upgrade to 1.6.2, went on loading grammars from the install the
 * upgrade removed, and wrote every file its watcher re-indexed as empty. A
 * launcher that found it could only serve its own session in-process, read-only:
 * the old daemon held the project's writer lock and file watcher, so no daemon
 * from the new install could start. Daemons from before the fix cannot notice
 * the upgrade themselves, so the launcher acts: a daemon of an OLDER release is
 * stopped the way `codegraph daemon` stops one (identity-checked SIGTERM, a
 * graceful shutdown on POSIX) and one from the launcher's own install takes its
 * place. The launcher hears an older daemon's hello on its own socket, or —
 * when it listens elsewhere (on Windows, daemons before #2278 named their pipe
 * after the root as typed) — finds it by the project lock. A daemon of the
 * same, a newer or an unknown version is never touched, so two installed
 * versions cannot fight over the daemon.
 *
 * The end-to-end cases run real daemons of other versions: this build's dist/
 * linked into a temp "install" whose package.json carries another version. A
 * daemon resolves its version, and every grammar it loads, from its own files,
 * so that install's daemon advertises that version in its lock and its hello.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { encodeLockInfo, getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { isProcessAlive, stopOlderDaemon } from '../src/mcp/daemon-registry';
import { connectWithHello } from '../src/mcp/proxy';
import { CodeGraphPackageVersion, isOlderRelease } from '../src/mcp/version';
import { getWriterPidPath, readWriterLock, swapWriterLock } from '../src/mcp/writer-lock';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const DIST = path.resolve(__dirname, '../dist');
const NODE_MODULES = path.resolve(__dirname, '../node_modules');
const OLDER_DAEMON = path.resolve(__dirname, 'fixtures/older-daemon.cjs');

/** Plain releases always below / above any version this repo will carry. */
const OLDER = '0.0.1';
const NEWER = '999.0.0';

describe('isOlderRelease', () => {
  it('orders plain releases numerically', () => {
    expect(isOlderRelease('1.6.1', '1.6.2')).toBe(true);
    expect(isOlderRelease('1.6.9', '1.6.10')).toBe(true);
    expect(isOlderRelease('1.9.0', '1.10.0')).toBe(true);
    expect(isOlderRelease('0.99.99', '1.0.0')).toBe(true);
    expect(isOlderRelease('1.6.2', '1.6.2')).toBe(false);
    expect(isOlderRelease('1.6.3', '1.6.2')).toBe(false);
    expect(isOlderRelease('2.0.0', '1.99.99')).toBe(false);
  });

  it('never calls a prerelease, a build or an unknown version older, in either position', () => {
    for (const odd of ['0.0.0-unknown', '0.0.0-mismatch', '1.6.1-beta.1', '1.6.1+local', 'v1.6.1', 'unknown', 'test', '', '1.6']) {
      expect(isOlderRelease(odd, '1.6.2'), odd).toBe(false);
      expect(isOlderRelease('1.6.1', odd), odd).toBe(false);
    }
  });

  it('lets at most one of two versions replace the other', () => {
    const versions = ['0.9.0', '1.6.1', '1.6.2', '1.6.10', '1.7.0', '2.0.0', '1.6.2-rc.1', '0.0.0-unknown'];
    for (const a of versions) {
      for (const b of versions) {
        expect(isOlderRelease(a, b) && isOlderRelease(b, a), `${a} / ${b}`).toBe(false);
      }
    }
  });
});

/** A path a test server can listen on: a named pipe on Windows, a socket file elsewhere. */
function listenPath(dir: string, name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(dir)}-${name}`
    : path.join(dir, `${name}.sock`);
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

describe('connectWithHello', () => {
  let dir: string;
  let server: net.Server | null = null;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hello-')); });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [OLDER, 'older-version', false],
    [NEWER, 'version-mismatch', true],
    ['0.0.0-unknown', 'version-mismatch', true],
  ])('reports a %s daemon as %s', async (version, expected, logged) => {
    const socketPath = listenPath(dir, 'daemon');
    server = net.createServer((socket) => {
      socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    });
    await listen(server, socketPath);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await connectWithHello(socketPath, '1.6.2')).toBe(expected);
      // An older daemon is the launcher's to report; it is not a mismatch to serve around.
      expect(stderr.mock.calls.some(([line]) => String(line).includes('differs from ours'))).toBe(logged);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('swapWriterLock', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-writer-swap-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const record = (pid: number, mode: string) => ({ pid, mode, startedAt: 1, ready: false });

  it('replaces the record of the given pid, and only that record', () => {
    const file = getWriterPidPath(root);
    fs.writeFileSync(file, JSON.stringify(record(111, 'daemon')) + '\n');
    expect(swapWriterLock(root, 222, record(333, 'handover'))).toBe(false);
    expect(readWriterLock(root)).toMatchObject({ pid: 111, mode: 'daemon' });
    expect(swapWriterLock(root, 111, record(333, 'handover'))).toBe(true);
    expect(readWriterLock(root)).toMatchObject({ pid: 333, mode: 'handover' });
    // A slot nobody holds is not handed over: it is acquired the usual way.
    fs.rmSync(file);
    expect(swapWriterLock(root, 333, record(444, 'daemon'))).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.join(root, '.codegraph'))).toEqual([]);
  });
});

/** A live process to stand in for a daemon; signals reach it, never the test. */
function startDetachedProcess(): number {
  const source = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    'console.log(child.pid);',
  ].join(' ');
  const pid = Number(execFileSync(process.execPath, ['-e', source], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('could not start daemon fixture');
  return pid;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  await new Promise((r) => setTimeout(r, 50));
  return child.pid!;
}

describe('stopOlderDaemon', () => {
  let root: string;
  let pidPath: string;
  let socketPath: string;
  let server: net.Server | null;
  let pids: number[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-older-daemon-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    pidPath = getDaemonPidPath(root);
    socketPath = getDaemonSocketPath(root);
    server = null;
    pids = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A daemon of `version`: its lock, and a socket answering the hello as `helloPid`. */
  async function fakeDaemon(version: string, helloPid?: number): Promise<{ pid: number; lock: string }> {
    const pid = startDetachedProcess();
    pids.push(pid);
    server = net.createServer((socket) => {
      socket.end(JSON.stringify({ protocol: 1, codegraph: version, pid: helloPid ?? pid, socketPath }) + '\n');
    });
    await listen(server, socketPath);
    const lock = encodeLockInfo({ pid, version, socketPath, startedAt: Date.now() });
    fs.writeFileSync(pidPath, lock);
    return { pid, lock };
  }

  /** Signals sent to `pid`, other than the signal-0 liveness probe. */
  function signalsTo(kill: ReturnType<typeof vi.spyOn>, pid: number): unknown[] {
    return kill.mock.calls.filter(([target, signal]) => target === pid && signal !== 0).map(([, signal]) => signal);
  }

  /** The writer record, decoded. */
  const writerRecord = (): any => {
    try { return JSON.parse(fs.readFileSync(getWriterPidPath(root), 'utf8')); } catch { return null; }
  };

  it('stops a verified daemon of an older release and clears its lock', async () => {
    const { pid } = await fakeDaemon('1.6.1');
    const result = await stopOlderDaemon(root, '1.6.2');
    expect(result).toMatchObject({ pid, outcome: 'term', version: '1.6.1' });
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
    // Kept for the daemon the caller starts next.
    expect(writerRecord()).toMatchObject({ pid: process.pid, mode: 'handover' });
  }, 15000);

  it('holds the writer slot from before the signal, so it is never free or stale', async () => {
    const { pid } = await fakeDaemon('1.6.1');
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({ pid, mode: 'daemon', startedAt: 1, ready: true }) + '\n');
    let atSignal: unknown = null;
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal === 'SIGTERM') atSignal = writerRecord();
      return originalKill(target, signal);
    });
    expect(await stopOlderDaemon(root, '1.6.2')).toMatchObject({ pid, outcome: 'term' });
    // A session of the old daemon serving itself the moment it went found the
    // slot held, and so served reads only.
    expect(atSignal).toMatchObject({ pid: process.pid, mode: 'handover' });
    expect(writerRecord()).toMatchObject({ pid: process.pid, mode: 'handover' });
    expect(fs.existsSync(pidPath)).toBe(false);
  }, 15000);

  it('gives the writer slot back to an older daemon that does not exit', async () => {
    const { pid, lock } = await fakeDaemon('1.6.1');
    const record = { pid, mode: 'daemon', startedAt: 1, ready: true };
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify(record) + '\n');
    // The signal reaches nothing: the daemon closes its socket, as its own
    // shutdown does first, and then never exits.
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal === 'SIGTERM') { server?.close(); return true; }
      return originalKill(target, signal);
    });
    expect(await stopOlderDaemon(root, '1.6.2', { shutdownGraceMs: 300 })).toMatchObject({ pid, outcome: 'still-running' });
    expect(writerRecord()).toEqual(record);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
    expect(isProcessAlive(pid)).toBe(true);
  }, 15000);

  it('leaves the daemon to another launcher already holding the slot to replace it', async () => {
    const { pid, lock } = await fakeDaemon('1.6.1');
    const other = startDetachedProcess();
    pids.push(other);
    const claim = { pid: other, mode: 'handover', startedAt: 1, ready: false };
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify(claim) + '\n');
    const kill = vi.spyOn(process, 'kill');
    expect(await stopOlderDaemon(root, '1.6.2')).toBeNull();
    expect(signalsTo(kill, pid)).toEqual([]);
    expect(writerRecord()).toEqual(claim);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
  });

  it.each(['1.6.2', '1.6.3', '2.0.0', '1.6.1-beta.1', '0.0.0-unknown', 'test'])(
    'never signals a daemon of version %s',
    async (version) => {
      const { pid, lock } = await fakeDaemon(version);
      const kill = vi.spyOn(process, 'kill');
      expect(await stopOlderDaemon(root, '1.6.2')).toBeNull();
      expect(signalsTo(kill, pid)).toEqual([]);
      expect(isProcessAlive(pid)).toBe(true);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
    },
  );

  it('leaves an older lock alone when its socket answers for another process (#1553)', async () => {
    const { pid, lock } = await fakeDaemon('1.6.1', process.pid);
    const kill = vi.spyOn(process, 'kill');
    expect(await stopOlderDaemon(root, '1.6.2')).toMatchObject({ pid, outcome: 'unverified' });
    expect(signalsTo(kill, pid)).toEqual([]);
    expect(signalsTo(kill, process.pid)).toEqual([]);
    expect(isProcessAlive(pid)).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
  });

  it('reports an older daemon that already exited, leaving its lock to its successor', async () => {
    const lock = encodeLockInfo({ pid: await deadPid(), version: '1.6.1', socketPath, startedAt: Date.now() });
    fs.writeFileSync(pidPath, lock);
    expect(await stopOlderDaemon(root, '1.6.2')).toMatchObject({ outcome: 'not-running', version: '1.6.1' });
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
  });

  it('has nothing to stop without a lock, and leaves a listening socket alone', async () => {
    server = net.createServer((socket) => {
      socket.end(JSON.stringify({ protocol: 1, codegraph: '1.6.1', pid: process.pid, socketPath }) + '\n');
    });
    await listen(server, socketPath);
    expect(await stopOlderDaemon(root, '1.6.2')).toBeNull();
    expect(await connectWithHello(socketPath, '1.6.2')).toBe('older-version');
  });

  it('does not act on an unreadable lock', async () => {
    fs.mkdirSync(pidPath);
    expect(await stopOlderDaemon(root, '1.6.2')).toEqual({ root, pid: null, outcome: 'unverified' });
  });
});

/**
 * A CodeGraph install of `version`: this build's dist/, hard-linked file by
 * file (copied where a link is refused), next to a package.json of that version
 * and a link to this checkout's node_modules.
 */
function makeInstall(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-install-${version}-`));
  const linkTree = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) linkTree(source, target);
      else {
        try { fs.linkSync(source, target); } catch { fs.copyFileSync(source, target); }
      }
    }
  };
  linkTree(DIST, path.join(dir, 'dist'));
  fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version }) + '\n');
  return dir;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function lines(stream: NodeJS.ReadableStream, into: string[]): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      into.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
}

function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      let value: T | undefined | null | false;
      try { value = predicate(); } catch (e) { reject(e); return; }
      if (value) { resolve(value as T); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`)); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs, `pid ${pid} to exit`).then(() => true, () => false);
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

describe('a launcher meeting a daemon of another version (#2335)', () => {
  let olderInstall: string;
  let newerInstall: string;
  let tempDir: string;
  let realRoot: string;
  const sessions: Session[] = [];
  const daemonPids = new Set<number>();

  beforeAll(() => {
    olderInstall = makeInstall(OLDER);
    newerInstall = makeInstall(NEWER);
  });

  afterAll(async () => {
    for (const dir of [olderInstall, newerInstall]) {
      if (!dir) continue;
      // The link first: removing an install must never reach this checkout's modules.
      try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch { /* not created */ }
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-older-version-'));
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function appMain() { return 1; }\n');
    const cg = await CodeGraph.init(tempDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    realRoot = fs.realpathSync(tempDir);
  });

  afterEach(async () => {
    // Every launcher first (with the runtime flags there is no relaunch child),
    // then the losing daemon candidates, then the daemons themselves — and only
    // then the fixture: on Windows a live process inside it blocks the removal.
    await Promise.all(sessions.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    sessions.length = 0;
    const lockPid = (): number | null => readJson(path.join(realRoot, '.codegraph', 'daemon.pid'))?.pid ?? null;
    await settleLosingCandidates(tempDir, lockPid);
    const holder = lockPid();
    if (holder) daemonPids.add(holder);
    for (const pid of daemonPids) {
      if (pid === process.pid || !isAlive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
      await waitProcessExit(pid, 5000);
    }
    daemonPids.clear();
    removeSpawnLog(tempDir);
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 45_000);

  /** An agent session: `install`'s launcher, `serve --mcp` in the project. */
  function startSession(install: string | null, env: NodeJS.ProcessEnv = {}): Session {
    const bin = install ? path.join(install, 'dist', 'bin', 'codegraph.js') : BIN;
    const recorder = recordSpawns(tempDir);
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, bin, 'serve', '--mcp'], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_MCP_LOG_ATTACH: '1',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000',
        ...recorder.env,
        ...env,
      },
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => { /* ignore */ });
    child.stdin.on('error', () => { /* ignore */ });
    const session: Session = { child, stdout: [], stderr: [] };
    lines(child.stdout, session.stdout);
    lines(child.stderr, session.stderr);
    sessions.push(session);
    send(session, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, rootUri: `file://${tempDir}` },
    });
    return session;
  }

  function send(session: Session, msg: unknown): void {
    try { session.child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* gone */ }
  }

  async function status(session: Session, id: number, label: string): Promise<any> {
    send(session, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    const reply = await waitFor(() => findResponse(session.stdout, id), 20000, label).catch((err: Error) => {
      throw new Error(`${err.message}\n--- stderr ---\n${session.stderr.join('\n')}\n--- daemon.log ---\n${daemonLog()}`);
    });
    expect(reply.error, label).toBeUndefined();
    expect(reply.result?.isError, label).not.toBe(true);
    expect(JSON.stringify(reply.result), label).toContain('CodeGraph Status');
    return reply;
  }

  const attachedLine = (session: Session): string | undefined =>
    session.stderr.find((l) => l.includes('Attached to shared daemon'));
  const daemonLock = (): any => readJson(path.join(realRoot, '.codegraph', 'daemon.pid'));
  const writerLock = (): any => readJson(path.join(realRoot, '.codegraph', 'writer.pid'));
  const daemonLog = (): string => {
    try { return fs.readFileSync(path.join(realRoot, '.codegraph', 'daemon.log'), 'utf8'); } catch { return ''; }
  };

  /** A session of `install` attached to a daemon of its own, which owns the project. */
  async function sessionWithDaemon(install: string, version: string, env: NodeJS.ProcessEnv = {}): Promise<{ session: Session; pid: number }> {
    const session = startSession(install, env);
    await waitFor(() => attachedLine(session), 20000, `the ${version} session to attach`);
    // Attached means listening, not initialized: let the engine open the
    // database before anything stops this daemon.
    await status(session, 2, `a ${version} tool call`);
    const lock = daemonLock();
    expect(lock).toMatchObject({ version });
    expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
    daemonPids.add(lock.pid);
    return { session, pid: lock.pid };
  }

  /** A daemon process for the project, started the way a launcher starts one. */
  function startDaemon(env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; log: string[] } {
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--path', realRoot], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEGRAPH_DAEMON_INTERNAL: '1', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000', ...env },
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => { /* ignore */ });
    child.stdout.resume();
    const log: string[] = [];
    lines(child.stderr, log);
    daemonPids.add(child.pid!);
    return { child, log };
  }

  /** The slot as a launcher that just stopped an older daemon holds it: this test process stands in. */
  function holdWriterSlotForSuccessor(): string {
    const claim = JSON.stringify({ pid: process.pid, mode: 'handover', startedAt: Date.now(), ready: false }) + '\n';
    fs.writeFileSync(path.join(realRoot, '.codegraph', 'writer.pid'), claim);
    return claim;
  }

  it('a daemon takes over the writer slot held for it, and only that one', async () => {
    const claim = holdWriterSlotForSuccessor();

    // A daemon the slot is not held for finds it held, as by any live writer.
    const stranger = startDaemon({});
    const [strangerCode] = await once(stranger.child, 'exit');
    expect(strangerCode).toBe(1);
    expect(stranger.log.join('\n')).toContain(`writer lock held by PID ${process.pid} (handover mode)`);
    expect(fs.readFileSync(path.join(realRoot, '.codegraph', 'writer.pid'), 'utf8')).toBe(claim);

    const successor = startDaemon({ CODEGRAPH_DAEMON_HANDOVER: String(process.pid) });
    await waitFor(
      () => daemonLock()?.pid === successor.child.pid && successor.log.some((l) => l.includes('Listening on')),
      20000, 'the successor to listen',
    );
    expect(writerLock()).toMatchObject({ pid: successor.child.pid, mode: 'daemon' });
    expect(successor.log.join('\n')).toContain(`Took over the writer lock from launcher pid ${process.pid}`);
  }, 60000);

  it('a daemon the slot is held for outwaits a candidate still starting in its way', async () => {
    holdWriterSlotForSuccessor();
    // A racing launcher's candidate holds the daemon lock, still starting; it
    // cannot get the writer slot, so it will give up.
    const candidate = startDetachedProcess();
    daemonPids.add(candidate);
    const pidPath = path.join(realRoot, '.codegraph', 'daemon.pid');
    const candidateLock = encodeLockInfo({
      pid: candidate, version: CodeGraphPackageVersion, socketPath: getDaemonSocketPath(realRoot), startedAt: Date.now(),
    });
    fs.writeFileSync(pidPath, candidateLock);

    // Any other daemon yields to it at once.
    const yielding = startDaemon({});
    const [yieldingCode] = await once(yielding.child, 'exit');
    expect(yieldingCode).toBe(0);
    expect(yielding.log.join('\n')).toContain(`Another daemon (pid ${candidate}) already holds the lock`);

    const successor = startDaemon({ CODEGRAPH_DAEMON_HANDOVER: String(process.pid) });
    await waitFor(
      () => successor.log.some((l) => l.includes(`Waiting for daemon candidate pid ${candidate}`)),
      20000, 'the successor to wait for the candidate',
    );
    expect(successor.child.exitCode).toBeNull();
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(candidateLock);
    // The candidate gives up: its lock goes, then so does it.
    fs.rmSync(pidPath);
    process.kill(candidate, 'SIGKILL');
    await waitFor(
      () => daemonLock()?.pid === successor.child.pid && successor.log.some((l) => l.includes('Listening on')),
      20000, 'the successor to listen',
    );
    expect(writerLock()).toMatchObject({ pid: successor.child.pid, mode: 'daemon' });
  }, 60000);

  it('keeps the older daemon\'s sessions read-only through the replacement, even mid-call', async () => {
    const before = await sessionWithDaemon(olderInstall, OLDER);
    // The older session calls every 20ms throughout, so it serves itself
    // in-process the instant its daemon goes. Finding the writer slot free
    // then, it would claim it — with the code of the install being replaced.
    let next = 100;
    const calling = setInterval(() => {
      send(before.session, { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    }, 20);
    let after: Session;
    try {
      after = startSession(null);
      await waitFor(() => attachedLine(after), 30000, 'the new session to attach');
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearInterval(calling);
    }
    const lock = daemonLock();
    daemonPids.add(lock.pid);
    expect(lock.version).toBe(CodeGraphPackageVersion);
    expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
    await status(after, 2, 'a tool call through the new daemon');

    const last = next - 1;
    await waitFor(() => findResponse(before.session.stdout, last), 20000, 'the older session to answer every call');
    for (let id = 100; id <= last; id++) expect(findResponse(before.session.stdout, id), `call ${id}`).toBeTruthy();
    const stderr = before.session.stderr.join('\n');
    expect(stderr).toContain('Serving reads in-process without auto-sync');
    expect(stderr).not.toContain('File watcher active');
    expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
  }, 120000);

  it('stops a daemon from an older install and starts one from its own', async () => {
    const before = await sessionWithDaemon(olderInstall, OLDER);

    const after = startSession(null);
    const stopped = await waitFor(
      () => after.stderr.find((l) => l.includes('[CodeGraph MCP] Stopped')),
      30000, 'the older daemon to be stopped',
    );
    expect(stopped).toContain(`the CodeGraph ${OLDER} daemon (pid ${before.pid})`);
    expect(stopped).toContain(`from this install (${CodeGraphPackageVersion})`);
    expect(await waitProcessExit(before.pid, 10000)).toBe(true);

    const attached = await waitFor(() => attachedLine(after), 20000, 'the new session to attach');
    const lock = daemonLock();
    daemonPids.add(lock.pid);
    expect(lock.version).toBe(CodeGraphPackageVersion);
    expect(lock.pid).not.toBe(before.pid);
    expect(attached).toContain(`(pid ${lock.pid}, v${CodeGraphPackageVersion})`);
    await status(after, 2, 'a tool call through the new daemon');
    // The replacement owns updates for the project: writer lock and watcher,
    // handed to it by the launcher that held the slot through the stop.
    expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
    expect(daemonLog()).toContain(`Took over the writer lock from launcher pid ${after.child.pid}`);
    if (process.platform !== 'win32') {
      // SIGTERM ran the old daemon's own shutdown. (On Windows it is
      // TerminateProcess, and the stop clears what is left.)
      expect(daemonLog()).toContain(`Shutting down (SIGTERM`);
    }

    // The session from before the upgrade keeps answering, read-only, and
    // leaves the new daemon its writer lock.
    await waitFor(
      () => before.session.stderr.some((l) => l.includes('Shared daemon connection lost')),
      10000, 'the older session to lose its daemon',
    );
    await status(before.session, 3, 'a tool call in the older session');
    expect(before.session.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
    expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
    expect(daemonLock()).toEqual(lock);
    expect(isAlive(lock.pid)).toBe(true);
  }, 120000);

  it('finds an older daemon its probe cannot reach by the project lock, and stops it', async () => {
    // On Windows a 1.6.1 daemon named its pipe after the root as typed (#2278),
    // so a newer launcher's probe never hears its hello; only its lock says
    // where it listens. Stand one up on a socket no launcher probes.
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sock-'));
    try {
      const socketPath = listenPath(socketDir, 'older');
      const older = spawn(process.execPath, [OLDER_DAEMON, realRoot, OLDER, socketPath], { detached: true, stdio: 'ignore' });
      older.unref();
      daemonPids.add(older.pid!);
      await waitFor(() => daemonLock()?.pid === older.pid, 10000, 'the older daemon to hold the project');
      expect(writerLock()).toMatchObject({ pid: older.pid, mode: 'daemon' });

      const session = startSession(null);
      const stopped = await waitFor(
        () => session.stderr.find((l) => l.includes('[CodeGraph MCP] Stopped')),
        30000, 'the older daemon to be stopped',
      );
      expect(stopped).toContain(`the CodeGraph ${OLDER} daemon (pid ${older.pid})`);
      expect(await waitProcessExit(older.pid!, 10000)).toBe(true);
      const attached = await waitFor(() => attachedLine(session), 20000, 'the session to attach');
      const lock = daemonLock();
      daemonPids.add(lock.pid);
      expect(lock.version).toBe(CodeGraphPackageVersion);
      expect(attached).toContain(`(pid ${lock.pid}, v${CodeGraphPackageVersion})`);
      expect(writerLock()).toMatchObject({ pid: lock.pid, mode: 'daemon' });
      expect(daemonLog()).toContain(`Took over the writer lock from launcher pid ${session.child.pid}`);
      await status(session, 2, 'a tool call through the new daemon');
    } finally {
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  }, 90000);

  it('never stops a daemon from a newer install', async () => {
    const retry = { CODEGRAPH_DAEMON_RETRY_MS: '300', CODEGRAPH_DAEMON_RETRY_MAX_MS: '600' };
    const newer = await sessionWithDaemon(newerInstall, NEWER);
    const lock = daemonLock();

    const current = startSession(null, retry);
    // The first probe and the retries that follow all find the newer daemon.
    await waitFor(
      () => current.stderr.filter((l) => l.includes(`version (${NEWER}) differs from ours`)).length >= 3,
      20000, 'repeated probes of the newer daemon',
    );
    await status(current, 2, 'a tool call served in-process');
    expect(current.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
    expect(current.stderr.some((l) => l.includes('[CodeGraph MCP] Stopped'))).toBe(false);

    expect(isAlive(newer.pid)).toBe(true);
    expect(daemonLock()).toEqual(lock);
    expect(writerLock()).toMatchObject({ pid: newer.pid, mode: 'daemon' });
    await status(newer.session, 3, 'a tool call through the newer daemon');
  }, 90000);
});
