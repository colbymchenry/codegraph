import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  getRegistryDir,
  isProcessAlive,
  registerDaemon,
  deregisterDaemon,
  listDaemons,
  listVerifiedDaemons,
  clearStaleDaemonArtifacts,
  stopDaemonAt,
  type DaemonRecord,
} from '../src/mcp/daemon-registry';
import { encodeLockInfo, getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { releaseWriterLock, tryAcquireWriterLock } from '../src/mcp/writer-lock';

/** A pid that's guaranteed dead: spawn a trivial process, let it exit, reap it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise<void>((r) => child.on('exit', () => r()));
  await new Promise((r) => setTimeout(r, 50)); // let the OS reap it
  return pid;
}

function rec(root: string, pid: number, startedAt = Date.now()): Omit<DaemonRecord, 'indexDir'> {
  return { root, pid, version: '1.0.0', socketPath: `${root}/.codegraph/daemon.sock`, startedAt };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));
}

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

describe('daemon-registry', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-reg-home-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome; // os.homedir() honors HOME (POSIX) ...
    process.env.USERPROFILE = tmpHome; // ... and USERPROFILE (Windows)
    // Sanity: the registry must resolve under our temp home, or the test would
    // pollute the real ~/.codegraph.
    expect(getRegistryDir().startsWith(tmpHome)).toBe(true);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('isProcessAlive', () => {
    it('is true for our own process and false for junk/dead pids', async () => {
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
      expect(isProcessAlive(await deadPid())).toBe(false);
    });
  });

  it('does not signal a live PID unless its socket identifies a CodeGraph daemon', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-foreign-daemon-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    const pid = startDetachedProcess();
    fs.writeFileSync(
      getDaemonPidPath(root),
      encodeLockInfo({ pid, version: 'test', socketPath: path.join(root, '.codegraph', 'missing.sock'), startedAt: Date.now() }),
    );

    try {
      const result = await stopDaemonAt(root, { preserveUnverified: true });
      expect(result.outcome).toBe('unverified');
      expect(isProcessAlive(pid)).toBe(true);
      expect(fs.existsSync(getDaemonPidPath(root))).toBe(true);
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('confirms daemon termination (refused: %s)', async (refused) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-identity-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    const socketPath = getDaemonSocketPath(root);
    const pid = startDetachedProcess();
    const server = net.createServer((socket) => {
      socket.end(`${JSON.stringify({ protocol: 1, codegraph: 'test', pid, socketPath })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.writeFileSync(
      getDaemonPidPath(root),
      encodeLockInfo({ pid, version: 'test', socketPath, startedAt: Date.now() }),
    );

    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (refused && target === pid && signal !== 0) {
        throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
      }
      return originalKill(target, signal);
    });
    try {
      const result = await stopDaemonAt(root);
      if (refused) {
        expect(result.outcome).toBe('still-running');
        expect(isProcessAlive(pid)).toBe(true);
        expect(fs.existsSync(getDaemonPidPath(root))).toBe(true);
        return;
      }
      expect(result.outcome).toMatch(/term|kill/);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      kill.mockRestore();
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  /**
   * A daemon fixture whose SIGTERM (intercepted; nothing is delivered) runs
   * `onTerm` — the shape of its graceful shutdown — instead of exiting.
   * `exitAfter(ms)` ends the process for real, as the end of that shutdown.
   */
  async function stoppingDaemon(
    root: string,
    onTerm: (daemon: { server: net.Server; pidPath: string; exitAfter: (ms: number) => void }) => void,
  ): Promise<{ root: string; pid: number; pidPath: string; signalled: (signal: string) => boolean; dispose: () => Promise<void> }> {
    fs.mkdirSync(path.join(root, '.codegraph'));
    const socketPath = getDaemonSocketPath(root);
    const pidPath = getDaemonPidPath(root);
    const pid = startDetachedProcess();
    const server = net.createServer((socket) => {
      socket.end(`${JSON.stringify({ protocol: 1, codegraph: 'test', pid, socketPath })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.writeFileSync(pidPath, encodeLockInfo({ pid, version: 'test', socketPath, startedAt: Date.now() }));
    const originalKill = process.kill.bind(process);
    let exitTimer: NodeJS.Timeout | undefined;
    const exitAfter = (ms: number): void => { exitTimer = setTimeout(() => originalKill(pid, 'SIGKILL'), ms); };
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal === 'SIGTERM') {
        onTerm({ server, pidPath, exitAfter });
        return true;
      }
      return originalKill(target, signal);
    });
    return {
      root,
      pid,
      pidPath,
      signalled: (signal) => kill.mock.calls.some(([target, sent]) => target === pid && sent === signal),
      dispose: async () => {
        clearTimeout(exitTimer);
        kill.mockRestore();
        if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it('waits for a daemon that has closed its socket but is still shutting down', async () => {
    // A daemon's shutdown closes its socket first, then waits up to 15 s for
    // query workers still starting up before it exits. Past the first 3 s the
    // identity probe fails; that is a daemon still stopping, not a stranger.
    const daemon = await stoppingDaemon(fs.mkdtempSync(path.join(tmpHome, 'stop-slow-')), ({ server, exitAfter }) => {
      server.close();
      exitAfter(4000);
    });
    try {
      const result = await stopDaemonAt(daemon.root);
      expect(result.outcome).toBe('term');
      expect(isProcessAlive(daemon.pid)).toBe(false);
      expect(daemon.signalled('SIGKILL')).toBe(false);
      expect(fs.existsSync(daemon.pidPath)).toBe(false);
    } finally {
      await daemon.dispose();
    }
  }, 15000);

  it('waits for a daemon that has released its lock but not yet exited', async () => {
    // The end of the same shutdown: the lock goes just before the process does.
    // A stop that looks then must wait for the exit, not report it running.
    const daemon = await stoppingDaemon(fs.mkdtempSync(path.join(tmpHome, 'stop-unlocked-')), ({ server, pidPath, exitAfter }) => {
      server.close();
      fs.unlinkSync(pidPath);
      exitAfter(4000);
    });
    try {
      const result = await stopDaemonAt(daemon.root);
      expect(result.outcome).toBe('term');
      expect(isProcessAlive(daemon.pid)).toBe(false);
      expect(daemon.signalled('SIGKILL')).toBe(false);
    } finally {
      await daemon.dispose();
    }
  }, 15000);

  it('still reports a daemon whose shutdown never finishes, without force-killing it', async () => {
    // The wait is bounded: past it, a daemon that closed its socket and never
    // exited is reported, and with no socket to re-prove its identity it is
    // left alone rather than SIGKILLed.
    const daemon = await stoppingDaemon(fs.mkdtempSync(path.join(tmpHome, 'stop-wedged-')), ({ server }) => {
      server.close();
    });
    try {
      const started = Date.now();
      const result = await stopDaemonAt(daemon.root, { shutdownGraceMs: 300 });
      expect(result.outcome).toBe('still-running');
      expect(Date.now() - started).toBeLessThan(8000);
      expect(isProcessAlive(daemon.pid)).toBe(true);
      expect(daemon.signalled('SIGKILL')).toBe(false);
      expect(fs.existsSync(daemon.pidPath)).toBe(true);
    } finally {
      await daemon.dispose();
    }
  }, 15000);

  it('preserves a newer lock installed during a successful stop identity probe', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'stop-race-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    const pid = startDetachedProcess();
    const socketPath = getDaemonSocketPath(root);
    const pidPath = getDaemonPidPath(root);
    const original = { pid, version: 'test', socketPath, startedAt: 1 };
    const replacement = encodeLockInfo({ ...original, startedAt: 2 });
    fs.writeFileSync(pidPath, encodeLockInfo(original));
    const server = net.createServer(socket => {
      fs.writeFileSync(pidPath, replacement);
      socket.end(JSON.stringify({ protocol: 1, codegraph: 'test', pid }) + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      expect((await stopDaemonAt(root, { preserveUnverified: true })).outcome).toBe('unverified');
      expect(isProcessAlive(pid)).toBe(true);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(replacement);
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('listDaemons returns [] when nothing is registered (no dir yet)', () => {
    expect(listDaemons()).toEqual([]);
  });

  it('register → list shows a live daemon; deregister removes it', () => {
    registerDaemon(rec('/proj/a', process.pid));
    const live = listDaemons();
    expect(live).toHaveLength(1);
    expect(live[0].root).toBe('/proj/a');
    expect(live[0].pid).toBe(process.pid);

    deregisterDaemon('/proj/a');
    expect(listDaemons()).toEqual([]);
  });

  it('prunes records whose process is dead', async () => {
    const dead = await deadPid();
    registerDaemon(rec('/proj/dead', dead));
    registerDaemon(rec('/proj/live', process.pid));

    const live = listDaemons();
    expect(live).toHaveLength(1);
    expect(live[0].root).toBe('/proj/live');

    // The dead record's file was deleted as a side effect.
    const remaining = fs.readdirSync(getRegistryDir()).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(1);
  });

  it('peeking with prune:false leaves dead records on disk', async () => {
    const dead = await deadPid();
    registerDaemon(rec('/proj/dead', dead));
    expect(listDaemons({ prune: false })).toEqual([]); // dead is filtered from results
    // ...but the file survives for the caller to inspect.
    expect(fs.readdirSync(getRegistryDir()).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('lists multiple live daemons newest-first', () => {
    registerDaemon(rec('/proj/old', process.pid, 1000));
    registerDaemon(rec('/proj/new', process.pid, 2000));
    const live = listDaemons();
    expect(live.map((d) => d.root)).toEqual(['/proj/new', '/proj/old']);
  });

  it('keeps a registry entry whose socket hello matches its PID and version', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'verified-'));
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-reg-${process.pid}-${Date.now()}`
      : path.join(tmpHome, 'verified.sock');
    const server = net.createServer((socket) => {
      socket.end(JSON.stringify({
        protocol: 1,
        pid: process.pid,
        codegraph: '1.5.0',
        socketPath,
      }) + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      registerDaemon({ root, pid: process.pid, version: '1.5.0', socketPath, startedAt: 1 });
      expect((await listVerifiedDaemons()).map((d) => d.root)).toEqual([root]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never signals a reused live PID when no matching daemon answers (#1553)', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'project-'));
    const pidPath = getDaemonPidPath(root);
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, encodeLockInfo({
      pid: process.pid,
      version: '1.5.0',
      socketPath: path.join(root, '.codegraph', 'missing.sock'),
      startedAt: Date.now() - 60_000,
    }));

    registerDaemon({
      root,
      pid: process.pid,
      version: '1.5.0',
      socketPath: path.join(root, '.codegraph', 'missing.sock'),
      startedAt: Date.now() - 60_000,
    });

    expect(await listVerifiedDaemons()).toEqual([]);
    const result = await stopDaemonAt(root);
    expect(result).toMatchObject({ pid: process.pid, outcome: 'not-running' });
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('preserves a live legacy lock when stop cannot verify daemon identity', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'legacy-stop-'));
    const pidPath = getDaemonPidPath(root);
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${process.pid}\n`);

    const result = await stopDaemonAt(root);

    expect(result).toMatchObject({ pid: process.pid, outcome: 'unverified' });
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(`${process.pid}\n`);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('preserves a replacement lock written while stale identity is probed', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'probe-race-'));
    const pidPath = getDaemonPidPath(root);
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-race-old-${process.pid}-${Date.now()}`
      : path.join(tmpHome, 'probe-race-old.sock');
    const replacementSocketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-race-new-${process.pid}-${Date.now()}`
      : path.join(tmpHome, 'probe-race-new.sock');
    let acceptConnection!: () => void;
    const connected = new Promise<void>((resolve) => { acceptConnection = resolve; });
    let acceptedSocket: net.Socket | null = null;
    const server = net.createServer((socket) => {
      acceptedSocket = socket;
      acceptConnection();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const original = encodeLockInfo({
      pid: process.pid,
      version: '1.5.0',
      socketPath,
      startedAt: 1,
    });
    const replacement = encodeLockInfo({
      pid: process.pid,
      version: '1.5.0',
      socketPath: replacementSocketPath,
      startedAt: 2,
    });
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, original);

    try {
      const clearing = clearStaleDaemonArtifacts(root);
      await connected;
      fs.writeFileSync(pidPath, replacement);
      acceptedSocket!.end('{"protocol":0}\n');

      expect(await clearing).toBe(false);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(replacement);
    } finally {
      acceptedSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not clean daemon artifacts while another writer owns the project', async () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'writer-claim-'));
    const pidPath = getDaemonPidPath(root);
    const lock = encodeLockInfo({
      pid: process.pid,
      version: '1.5.0',
      socketPath: path.join(root, '.codegraph', 'not-listening.sock'),
      startedAt: 1,
    });
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, lock);
    expect(tryAcquireWriterLock(root, 'daemon').kind).toBe('acquired');

    try {
      expect(await clearStaleDaemonArtifacts(root)).toBe(false);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(lock);
    } finally {
      releaseWriterLock(root);
    }
  });
});
