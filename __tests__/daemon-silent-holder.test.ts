/**
 * A process that holds the daemon's pipe but never says hello no longer stalls
 * a session's first tool call for minutes.
 *
 * In practice that holder is a shared daemon whose main thread is blocked: the
 * OS still accepts connections on its pipe, but the hello never comes. After
 * the first probe the launcher spawned a daemon (which can't take the lock
 * from a live holder) and polled for one 240 times; each probe waited out the
 * whole 3s hello timeout, so the first call waited about 12 minutes. The poll
 * now has a wall-clock budget, after which the session is served in-process
 * as when a spawned daemon never binds, and the proxy's retries (#2277) pick
 * the daemon up again once its watchdog has replaced it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { connectAnyDaemonCandidate, pollForDaemon } from '../src/mcp/index';
import { connectWithHello, DAEMON_HELLO_TIMEOUT_MS } from '../src/mcp/proxy';
import { getDaemonPidPath, getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import { getWriterPidPath } from '../src/mcp/writer-lock';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/** A clock the poll runs on, moved only by its sleeps and by the probes. */
function fakeClock(): { now(): number; sleep(ms: number): Promise<void>; advance(ms: number): void } {
  let t = 1_000;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

describe('the poll for a spawned daemon', () => {
  it('gives up within its budget when the pipe holder never says hello', async () => {
    const clock = fakeClock();
    const started = clock.now();
    const waits: number[] = [];
    // What the launcher's probe does: wait for a hello, at most to the deadline.
    const silent = async (deadline: number): Promise<null> => {
      const wait = Math.min(DAEMON_HELLO_TIMEOUT_MS, deadline - clock.now());
      waits.push(wait);
      clock.advance(wait);
      return null;
    };
    expect(await pollForDaemon(silent, 6_000, 25, clock)).toBeNull();
    // 240 probes of 3s each was the old wait: about 12 minutes.
    expect(clock.now() - started).toBeLessThanOrEqual(6_000 + 25);
    expect(waits.every((w) => w > 0 && w <= DAEMON_HELLO_TIMEOUT_MS)).toBe(true);
    expect(waits.length).toBeLessThanOrEqual(3);
  });

  it('attaches the moment a daemon answers', async () => {
    const clock = fakeClock();
    const started = clock.now();
    const socket = { daemon: true };
    const binds = async (): Promise<typeof socket | null> => (clock.now() - started >= 400 ? socket : null);
    expect(await pollForDaemon(binds, 6_000, 25, clock)).toBe(socket);
    expect(clock.now() - started).toBeLessThan(500);
  });

  it('stops at once for a daemon of another version', async () => {
    const clock = fakeClock();
    const started = clock.now();
    for (const answer of ['older-version', 'version-mismatch'] as const) {
      expect(await pollForDaemon(async () => answer, 6_000, 25, clock)).toBeNull();
    }
    expect(clock.now() - started).toBe(50);
  });
});

describe('the probe of the socket candidates', () => {
  it('caps each hello wait at what is left before the deadline', async () => {
    const clock = fakeClock();
    const calls: Array<[string, number]> = [];
    const silent = async (where: string, _version?: string, timeout = DAEMON_HELLO_TIMEOUT_MS): Promise<null> => {
      calls.push([where, timeout]);
      clock.advance(timeout);
      return null;
    };
    const deadline = clock.now() + DAEMON_HELLO_TIMEOUT_MS + 1_000;
    expect(await connectAnyDaemonCandidate(['first', 'second', 'third'], deadline, silent, clock.now)).toBeNull();
    expect(calls).toEqual([['first', DAEMON_HELLO_TIMEOUT_MS], ['second', 1_000]]);
  });

  it('gives each candidate the full hello timeout without a deadline, and returns the first answer', async () => {
    const clock = fakeClock();
    const calls: Array<[string, number]> = [];
    const socket = new net.Socket();
    const second = async (where: string, _version?: string, timeout = DAEMON_HELLO_TIMEOUT_MS): Promise<net.Socket | null> => {
      calls.push([where, timeout]);
      return where === 'second' ? socket : null;
    };
    expect(await connectAnyDaemonCandidate(['first', 'second', 'third'], undefined, second, clock.now)).toBe(socket);
    expect(calls).toEqual([['first', DAEMON_HELLO_TIMEOUT_MS], ['second', DAEMON_HELLO_TIMEOUT_MS]]);
  });
});

describe('a probe of a pipe holder that never says hello', () => {
  const servers: net.Server[] = [];
  const held: net.Socket[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of held.splice(0)) s.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives up after the hello timeout it is given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-silent-'));
    dirs.push(dir);
    const where = process.platform === 'win32'
      ? `\\\\.\\pipe\\cg-silent-${process.pid}-${Date.now()}`
      : path.join(dir, 's.sock');
    const server = net.createServer((socket) => { held.push(socket); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(where, resolve));
    const started = Date.now();
    expect(await connectWithHello(where, CodeGraphPackageVersion, 300)).toBeNull();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(DAEMON_HELLO_TIMEOUT_MS);
  });
});

/**
 * End to end: the real launcher against a project whose daemon pipe, lock and
 * writer slot are held by a "daemon" that never says hello (this test
 * process), as a daemon whose main thread is blocked keeps them.
 */
describe('a session whose daemon never says hello', () => {
  let root: string;
  let launcher: ChildProcessWithoutNullStreams | null = null;
  let holder: net.Server | null = null;
  const held: net.Socket[] = [];

  const lockPid = (): number | null => {
    try { return (JSON.parse(fs.readFileSync(getDaemonPidPath(root), 'utf8')) as { pid: number }).pid; } catch { return null; }
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  };

  async function project(): Promise<void> {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-silent-holder-')));
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha(): number { return 1; }\n');
    (await CodeGraph.init(root, { index: true })).close();
  }

  async function holdPipe(): Promise<void> {
    const pipe = getDaemonSocketCandidates(root)[0]!;
    holder = net.createServer((socket) => { held.push(socket); });
    await new Promise<void>((resolve) => holder!.listen(pipe, resolve));
    fs.writeFileSync(getDaemonPidPath(root), JSON.stringify({
      pid: process.pid, version: CodeGraphPackageVersion, socketPath: pipe, startedAt: Date.now() - 60_000,
    }));
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({
      pid: process.pid, mode: 'daemon', startedAt: Date.now() - 60_000, ready: true,
    }) + '\n');
  }

  /** What the liveness watchdog's kill leaves: no pipe, and records naming a dead pid. */
  async function killHolder(): Promise<void> {
    for (const s of held.splice(0)) s.destroy();
    if (holder) await new Promise<void>((resolve) => holder!.close(() => resolve()));
    holder = null;
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const pipe = getDaemonSocketCandidates(root)[0]!;
    fs.writeFileSync(getDaemonPidPath(root), JSON.stringify({
      pid: dead, version: CodeGraphPackageVersion, socketPath: pipe, startedAt: Date.now() - 120_000,
    }));
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({
      pid: dead, mode: 'daemon', startedAt: Date.now() - 120_000, ready: true,
    }) + '\n');
  }

  function launch(env: NodeJS.ProcessEnv): { send(m: unknown): void; out(): string; err(): string; replyTo(id: number): Promise<number | null> } {
    const recorder = recordSpawns(root);
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp', '--path', root], {
      cwd: os.tmpdir(),
      env: {
        ...process.env, ...recorder.env, ...env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_UPDATE_CHECK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    launcher = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => { /* gone */ });
    const answered = (id: number): boolean =>
      stdout.split('\n').some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
    return {
      send: (m) => { child.stdin.write(JSON.stringify(m) + '\n'); },
      out: () => stdout,
      err: () => stderr,
      replyTo: (id) => {
        const asked = Date.now();
        return new Promise((resolve) => {
          const iv = setInterval(() => {
            if (answered(id)) { clearInterval(iv); resolve(Date.now() - asked); }
            else if (Date.now() - asked > 45_000) { clearInterval(iv); resolve(null); }
          }, 50);
        });
      },
    };
  }

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const status = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
  const reply = (out: string, id: number) => out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.id === id);

  afterEach(async () => {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      const exited = new Promise<void>((resolve) => launcher!.once('exit', () => resolve()));
      launcher.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    }
    launcher = null;
    // Spawned daemons that lost the lock leave on their own, and must be gone
    // before the pipe, lock and fixture go away. One that won idles out.
    const winner = (): number => (holder ? process.pid : lockPid() ?? process.pid);
    await settleLosingCandidates(root, winner, 60_000);
    const daemon = winner();
    if (daemon !== process.pid) {
      const until = Date.now() + 30_000;
      while (alive(daemon) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      if (alive(daemon)) process.kill(daemon, 'SIGKILL');
    }
    removeSpawnLog(root);
    for (const s of held.splice(0)) s.destroy();
    if (holder) await new Promise<void>((resolve) => holder!.close(() => resolve()));
    holder = null;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }, 150_000);

  it('serves the first tool call in-process within the connect budget', async () => {
    await project();
    await holdPipe();
    // One connect attempt: this is about how long the first one may take.
    const session = launch({ CODEGRAPH_DAEMON_RETRY_MS: '0' });
    session.send(initialize);
    session.send(status(2));
    const took = await session.replyTo(2);
    // The first probe's hello timeout (3s) plus the 6s budget, with room for a
    // loaded machine; the old poll answered after about 12 minutes.
    expect(took, session.err()).not.toBeNull();
    expect(took!).toBeLessThan(30_000);
    expect(session.err()).toContain('Shared daemon unavailable; serving this session in-process');
    expect(reply(session.out(), 2).result.content[0].text).toContain('CodeGraph Status');
  }, 90_000);

  it('hands the session to the daemon that replaces the silent one', async () => {
    await project();
    await holdPipe();
    const session = launch({ CODEGRAPH_DAEMON_RETRY_MS: '1000', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1000' });
    session.send(initialize);
    session.send(status(2));
    expect(await session.replyTo(2), session.err()).not.toBeNull();
    expect(session.err()).toContain('serving this session in-process');
    // The silent daemon's liveness watchdog kills it; the session's next retry
    // spawns a replacement and proxies to it.
    await killHolder();
    const until = Date.now() + 60_000;
    while (!session.err().includes('Shared daemon reachable; proxying this session to it') && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(session.err()).toContain('Shared daemon reachable; proxying this session to it');
    session.send(status(3));
    expect(await session.replyTo(3), session.err()).not.toBeNull();
    const daemon = lockPid();
    expect(daemon).not.toBeNull();
    expect(daemon).not.toBe(process.pid);
    expect(alive(daemon!)).toBe(true);
  }, 120_000);
});
