import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { CodeGraph } from '../src';
import { getCodeGraphDir } from '../src/directory';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import {
  encodeLockInfo,
  getDaemonIndexDir,
  getDaemonPidPath,
  getDaemonSocketCandidates,
  getDaemonSocketPath,
  rootDaemonSocketPath,
  socketAnswers,
} from '../src/mcp/daemon-paths';
import { buildPickItems, CANCEL, describeDaemon, runDaemonPicker, type PickItem } from '../src/mcp/daemon-manager';
import {
  clearStaleDaemonArtifacts,
  deregisterDaemon,
  getRegistryDir,
  isProcessAlive,
  listDaemons,
  listVerifiedDaemons,
  registerDaemon,
  stopAllDaemons,
  stopDaemonAt,
  stopOlderDaemon,
  stopRecordedDaemon,
  type DaemonRecord,
} from '../src/mcp/daemon-registry';
import { connectIndexDaemon, connectRootNamedDaemon } from '../src/mcp/index';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { readWriterLock, releaseWriterLock } from '../src/mcp/writer-lock';
import { __setWslWindowsDriveForTests } from '../src/sync/watch-policy';
import { recordedPids, recordSpawns } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const OLDER_RELEASE_DAEMON = path.resolve(__dirname, 'fixtures/older-release-daemon.cjs');
const WSL_WINDOWS_DRIVE = path.resolve(__dirname, 'fixtures/wsl-windows-drive.cjs');
/** The tmpdir fallback socket, where the older-release daemon listens, is POSIX's; Windows has a named pipe. */
const POSIX = process.platform !== 'win32';

/** The hash in a daemon's names: the first 16 hex digits of the SHA-256 of a canonical directory. */
const nameHash = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function waitFor<T>(predicate: () => T | null | undefined | false, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** A pid that is certainly dead: a process that has exited and been reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 50));
  return child.pid!;
}

/** A live process that is not this test's child, standing in for a daemon; signals reach it, never the test. */
function startDetachedProcess(): number {
  const source = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    'console.log(child.pid);',
  ].join(' ');
  return Number(execFileSync(process.execPath, ['-e', source], { encoding: 'utf8' }).trim());
}

describe('daemon index namespaces', () => {
  let home: string;
  let root: string;
  const servers: net.Server[] = [];
  const children: ChildProcess[] = [];
  const detached: number[] = [];
  /** Sockets a test may leave in the shared tmpdir. */
  const tmpSockets: string[] = [];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ns-')));
    root = path.join(home, 'project');
    fs.mkdirSync(root);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEGRAPH_DIR', '');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __setWslWindowsDriveForTests(null);
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    for (const pid of detached.splice(0)) {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    for (const server of servers.splice(0)) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    for (const socketPath of tmpSockets.splice(0)) fs.rmSync(socketPath, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function configure(name: string): string {
    vi.stubEnv('CODEGRAPH_DIR', name);
    const indexDir = getCodeGraphDir(root);
    fs.mkdirSync(indexDir, { recursive: true });
    return indexDir;
  }

  function withPlatform<T>(platform: 'linux' | 'win32', run: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try { return run(); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
  }

  async function withPlatformAsync<T>(platform: 'linux' | 'win32', run: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try { return await run(); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
  }

  /**
   * A server on `socketPath` that says the hello of daemon `pid`, of `version`,
   * and hands each connection to `onConnection` first.
   */
  async function answer(socketPath: string, pid: number, version = '1.6.2', onConnection: (socket: net.Socket) => void = () => {}): Promise<void> {
    const server = net.createServer(socket => {
      // Read what a client sends, as a daemon does, so the connection can close.
      socket.on('error', () => {});
      socket.resume();
      onConnection(socket);
      socket.end(JSON.stringify({ protocol: 1, codegraph: version, pid }) + '\n');
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  }

  /** A daemon of this release serving the index `name` of `at`: its socket, lock and record. */
  async function listeningDaemon(name: string, pid: number, at = root): Promise<void> {
    vi.stubEnv('CODEGRAPH_DIR', name);
    fs.mkdirSync(getCodeGraphDir(at), { recursive: true });
    const socketPath = getDaemonSocketPath(at);
    const lock = { pid, version: '1.6.2', socketPath, startedAt: pid };
    await answer(socketPath, pid);
    fs.writeFileSync(getDaemonPidPath(at), encodeLockInfo(lock));
    registerDaemon({ root: at, ...lock });
  }

  /**
   * A real daemon process of a release from before an index had names of its
   * own, serving the index `name` of the project: on the tmpdir fallback named
   * after the root, with its record filed under the root, as that release did
   * for every index.
   */
  async function olderReleaseDaemon(name: string, options: { stuck?: boolean; version?: string } = {}) {
    const indexDir = path.join(root, name);
    fs.mkdirSync(indexDir, { recursive: true });
    const hash = nameHash(fs.realpathSync.native(root));
    const socketPath = path.join(os.tmpdir(), `codegraph-${hash}.sock`);
    const recordFile = path.join(getRegistryDir(), `${hash}.json`);
    tmpSockets.push(socketPath);
    const args = [OLDER_RELEASE_DAEMON, indexDir, options.version ?? '0.0.1', socketPath, recordFile, ...(options.stuck ? ['stuck'] : [])];
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    children.push(child);
    const lockFile = path.join(indexDir, 'daemon.pid');
    await waitFor(() => readJson(lockFile)?.pid === child.pid, 10_000, 'the older daemon to hold its lock');
    const exited = (): Promise<boolean> =>
      waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 'the older daemon to exit');
    return { pid: child.pid!, exited, indexDir, socketPath, recordFile, lockFile };
  }

  const registryFiles = (): string[] => {
    try { return fs.readdirSync(getRegistryDir()).sort(); } catch { return []; }
  };

  /** A path a test server can listen on: a named pipe on Windows, a socket file elsewhere. */
  const listenPath = (name: string): string =>
    POSIX ? path.join(home, `${name}.sock`) : `\\\\.\\pipe\\${path.basename(home)}-${name}`;

  it.each(['linux', 'win32'] as const)('separates fallback sockets and pipes for two indexes on %s', platform => {
    withPlatform(platform, () => {
      configure('.codegraph-one');
      const a = getDaemonSocketCandidates(root);
      configure('.codegraph-two');
      const b = getDaemonSocketCandidates(root);
      expect(a.at(-1)).not.toBe(b.at(-1));
      if (platform === 'win32') {
        expect(a).toHaveLength(1);
        expect(a[0]).toMatch(/^\\\\\.\\pipe\\codegraph-/);
      } else {
        expect(a.at(-1)).toMatch(/codegraph-[a-f0-9]{16}\.sock$/);
      }
    });
  });

  it.each(['linux', 'win32'] as const)('canonicalizes equivalent root spellings within one namespace on %s', platform => {
    configure('.codegraph-one');
    withPlatform(platform, () => {
      const spelling = path.join(root, 'child', '..') + path.sep;
      expect(getDaemonSocketCandidates(spelling)).toEqual(getDaemonSocketCandidates(root));
      if (platform === 'win32') {
        expect(getDaemonSocketPath(root.toUpperCase())).toBe(getDaemonSocketPath(root));
      }
    });
  });

  it.each(['linux', 'win32'] as const)('names every index after its own directory, the default included, on %s', platform => {
    withPlatform(platform, () => {
      const key = (dir: string): string => platform === 'win32' ? fs.realpathSync.native(dir).toLowerCase() : fs.realpathSync.native(dir);
      const fallback = (hash: string): string =>
        platform === 'win32' ? `\\\\.\\pipe\\codegraph-${hash}` : path.join(os.tmpdir(), `codegraph-${hash}.sock`);
      const defaultIndex = configure('');
      const hash = nameHash(key(defaultIndex));
      expect(getDaemonSocketCandidates(root).at(-1)).toBe(fallback(hash));
      // The names a release before this one gave every index of the root are no index's now.
      expect(getDaemonSocketCandidates(root).at(-1)).not.toBe(fallback(nameHash(key(root))));
      expect(rootDaemonSocketPath(root)).toBe(fallback(nameHash(key(root))));
      registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: fallback(hash), startedAt: 1 });
      expect(registryFiles()).toEqual([`${hash}.json`]);

      configure('.codegraph');
      expect(getDaemonSocketCandidates(root).at(-1)).toBe(fallback(hash));
      const other = configure('.codegraph-other');
      expect(getDaemonSocketCandidates(root).at(-1)).toBe(fallback(nameHash(key(other))));
    });
  });

  it('keeps every name when the index WSL picks by default changes', () => {
    // On a Windows drive under WSL, `.codegraph` is the default only until
    // `.codegraph-wsl` exists, which `CODEGRAPH_DIR=.codegraph-wsl codegraph init` makes.
    __setWslWindowsDriveForTests(() => true);
    fs.mkdirSync(path.join(root, '.codegraph'));
    fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), '');
    expect(getDaemonIndexDir(root)).toBe(path.join(root, '.codegraph'));
    const before = getDaemonSocketCandidates(root);

    fs.mkdirSync(path.join(root, '.codegraph-wsl'));
    expect(getDaemonIndexDir(root)).toBe(path.join(root, '.codegraph-wsl'));
    expect(getDaemonSocketCandidates(root).at(-1)).not.toBe(before.at(-1));
    expect(getDaemonSocketCandidates(root, path.join(root, '.codegraph'))).toEqual(before);
  });

  it('keeps the root\'s own case in the paths it reads and writes on win32', async () => {
    const project = path.join(home, 'CaseRoot', 'MyProj');
    const lockPath = path.join(project, '.codegraph', 'daemon.pid');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, encodeLockInfo({ pid: await deadPid(), version: '1.6.2', socketPath: '\\\\.\\pipe\\codegraph-gone', startedAt: 1 }));
    await withPlatformAsync('win32', async () => {
      expect(getDaemonPidPath(project)).toBe(lockPath);
      // Only the pipe's name folds case, so every spelling meets at it.
      expect(getDaemonSocketPath(project.toUpperCase())).toBe(getDaemonSocketPath(project));
      expect(await clearStaleDaemonArtifacts(project)).toBe(true);
    });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(home).sort()).toEqual(['CaseRoot', 'project']);
  });

  it('keeps both registry records and deregisters only the configured index', () => {
    const one = configure('.codegraph-one');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 1 });
    const two = configure('.codegraph-two');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 2 });
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([two, one]);
    expect(registryFiles()).toHaveLength(2);
    deregisterDaemon(root);
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([one]);
  });

  it('converges symlinked project spellings on one socket and registry entry', () => {
    configure('.codegraph-one');
    const alias = path.join(home, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    // The in-project socket is one file under either spelling; the hashed names must be one string.
    expect(getDaemonSocketCandidates(alias).at(-1)).toBe(getDaemonSocketCandidates(root).at(-1));
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 1 });
    registerDaemon({ root: alias, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(alias), startedAt: 2 });
    expect(listDaemons()).toHaveLength(1);
    deregisterDaemon(root);
    expect(listDaemons()).toEqual([]);
  });

  it('does not find another namespace through the registry when its own lock is missing', async () => {
    configure('.codegraph-other');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 1 });
    configure('.codegraph-current');
    expect(await stopDaemonAt(root, { preserveUnverified: true })).toEqual({ root, pid: null, outcome: 'no-daemon' });
    expect(listDaemons()).toHaveLength(1);
  });

  it('prunes an unverified record from its own namespace while preserving another live one', async () => {
    await listeningDaemon('.codegraph-one', process.pid);
    const one = getCodeGraphDir(root);
    configure('.codegraph-two');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 2 });
    configure('.codegraph-one');
    expect((await listVerifiedDaemons()).map(rec => rec.indexDir)).toEqual([one]);
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([one]);
  });

  it('prunes an unverified record only while its file still holds that record', async () => {
    // While its socket is asked, a daemon that got the same pid takes the index
    // over and files its own record under the same name.
    configure('.codegraph-one');
    const socketPath = listenPath('reused');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath, startedAt: 1 });
    const [file] = registryFiles();
    const successor = { root, pid: process.pid, version: '1.6.2', socketPath, startedAt: 2, indexDir: getCodeGraphDir(root) };
    await answer(socketPath, await deadPid(), '1.6.2', () => {
      fs.writeFileSync(path.join(getRegistryDir(), file!), JSON.stringify(successor));
    });
    expect(await listVerifiedDaemons()).toEqual([]);
    expect(readJson(path.join(getRegistryDir(), file!))).toEqual(successor);
  });

  it('stops all recorded namespaces and cleans each namespace with its own writer lock', async () => {
    const pids = [910_001, 910_002];
    const live = new Set(pids);
    const signalled: number[] = [];
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!pids.includes(pid)) return originalKill(pid, signal);
      if (!live.has(pid)) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      if (signal !== 0) { signalled.push(pid); live.delete(pid); }
      return true;
    });
    await listeningDaemon('.codegraph-one', pids[0]!);
    const one = getCodeGraphDir(root);
    await listeningDaemon('.codegraph-two', pids[1]!);
    const two = getCodeGraphDir(root);
    configure('.codegraph-one');
    const results = await stopAllDaemons();
    expect(results.map(result => result.pid).sort()).toEqual(pids);
    expect(results.every(result => result.outcome === 'term')).toBe(true);
    expect(signalled.sort()).toEqual(pids);
    for (const indexDir of [one, two]) {
      expect(fs.existsSync(path.join(indexDir, 'daemon.pid'))).toBe(false);
      expect(fs.existsSync(path.join(indexDir, 'writer.pid'))).toBe(false);
    }
    expect(listDaemons()).toEqual([]);
  });

  it('leaves the record of a daemon that took its index over when a daemon deregisters', () => {
    // A daemon drops its lock before its record as it shuts down, so a successor
    // can take the index over and register in between.
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 1 });
    const file = path.join(getRegistryDir(), registryFiles()[0]!);
    const successor = { root, pid: process.pid + 1, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 2 };
    fs.writeFileSync(file, JSON.stringify(successor));
    deregisterDaemon(root, process.pid);
    expect(readJson(file)).toEqual(successor);
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 3 });
    deregisterDaemon(root, process.pid);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps the record of a live daemon whose pid a stale lock names, as reused pids do', async () => {
    // An older release's daemon of another index, alive and filed under the root.
    const live = listenPath('live');
    await answer(live, process.pid, '1.6.1');
    const rootRecord = path.join(getRegistryDir(), `${nameHash(fs.realpathSync.native(root))}.json`);
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    fs.writeFileSync(rootRecord, JSON.stringify({ root, pid: process.pid, version: '1.6.1', socketPath: live, startedAt: 1 }));
    // `.codegraph-b`'s lock and record, left by a daemon long gone whose pid that daemon now has.
    configure('.codegraph-b');
    const gone = path.join(getCodeGraphDir(root), 'gone.sock');
    const stale = { pid: process.pid, version: '1.6.2', socketPath: gone, startedAt: 2 };
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo(stale));
    registerDaemon({ root, ...stale });

    expect(await clearStaleDaemonArtifacts(root)).toBe(true);
    expect(fs.existsSync(getDaemonPidPath(root))).toBe(false);
    expect(registryFiles()).toEqual([path.basename(rootRecord)]);
    expect((await listVerifiedDaemons()).map(rec => rec.socketPath)).toEqual([live]);
  });

  it('counts a socket whose connection never settles as one in use', async () => {
    expect(await socketAnswers(listenPath('pending'), 20, () => new net.Socket())).toBe(true);
  });

  it.runIf(POSIX)('counts a socket it may not connect to as one in use', async () => {
    const socketPath = listenPath('private');
    await answer(socketPath, process.pid);
    fs.chmodSync(socketPath, 0o000);
    expect(await socketAnswers(socketPath)).toBe(true);
  });

  it('reads the index a record names, with nothing else to show it and whatever the reader\'s CODEGRAPH_DIR', () => {
    // A daemon of `index-a` on its fallback socket, its lock gone: only its record says which index it serves.
    const indexDir = configure('index-a');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketCandidates(root).at(-1)!, startedAt: 1 });
    vi.stubEnv('CODEGRAPH_DIR', '');
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([indexDir]);
  });

  it('clears another index under that index\'s writer slot, not the reader\'s', async () => {
    const holder = startDetachedProcess();
    detached.push(holder);
    const writer = JSON.stringify({ pid: holder, mode: 'daemon', startedAt: 1, ready: true }) + '\n';
    // The reader's own index has a live writer; `.codegraph-b`'s daemon died, leaving its lock.
    const own = configure('.codegraph-a');
    fs.writeFileSync(path.join(own, 'writer.pid'), writer);
    const other = path.join(root, '.codegraph-b');
    fs.mkdirSync(other);
    const lock = path.join(other, 'daemon.pid');
    const dead = await deadPid();
    fs.writeFileSync(lock, encodeLockInfo({ pid: dead, version: '1.6.2', socketPath: path.join(other, 'daemon.sock'), startedAt: 1 }));
    expect(await stopDaemonAt(root, { indexDir: other })).toMatchObject({ pid: dead, outcome: 'not-running' });
    expect(fs.existsSync(lock)).toBe(false);

    // While a live process holds `.codegraph-b`'s own slot, its lock stays.
    fs.rmSync(path.join(own, 'writer.pid'));
    fs.writeFileSync(path.join(other, 'writer.pid'), writer);
    fs.writeFileSync(lock, encodeLockInfo({ pid: dead, version: '1.6.2', socketPath: path.join(other, 'daemon.sock'), startedAt: 2 }));
    expect(await stopDaemonAt(root, { indexDir: other })).toMatchObject({ pid: dead, outcome: 'unverified' });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('removes the record of the index it clears, not the reader\'s', async () => {
    // `.codegraph-b`'s daemon was killed: its lock and its record stay behind.
    const other = configure('.codegraph-b');
    const killed = { pid: await deadPid(), version: '1.6.2', socketPath: path.join(other, 'daemon.sock'), startedAt: 1 };
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo(killed));
    registerDaemon({ root, ...killed });
    configure('.codegraph-a');
    expect(registryFiles()).toHaveLength(1);
    expect(await stopDaemonAt(root, { indexDir: other })).toMatchObject({ outcome: 'not-running' });
    expect(registryFiles()).toEqual([]);
  });

  it('removes the record of a daemon it found and stopped through that record alone', async () => {
    // `.codegraph-b`'s lock is gone, but its daemon runs and its record names it.
    const pid = startDetachedProcess();
    detached.push(pid);
    configure('.codegraph-b');
    const socketPath = listenPath('found');
    await answer(socketPath, pid);
    registerDaemon({ root, pid, version: '1.6.2', socketPath, startedAt: 1 });
    expect(await stopDaemonAt(root)).toMatchObject({ pid, outcome: 'term' });
    expect(isProcessAlive(pid)).toBe(false);
    expect(registryFiles()).toEqual([]);
  });

  /** A daemon of the index `codegraphDir` names, listening outside its index directory as the fallback socket does. */
  async function daemonOutside(codegraphDir: string, name: string): Promise<{ pid: number; indexDir: string }> {
    const pid = startDetachedProcess();
    detached.push(pid);
    vi.stubEnv('CODEGRAPH_DIR', codegraphDir);
    const indexDir = getDaemonIndexDir(root);
    fs.mkdirSync(indexDir, { recursive: true });
    const socketPath = listenPath(name);
    await answer(socketPath, pid);
    const lock = { pid, version: '1.6.2', socketPath, startedAt: 1 };
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo(lock));
    registerDaemon({ root, ...lock });
    return { pid, indexDir };
  }

  it('stops a daemon whose index directory was deleted, and leaves it deleted', async () => {
    const { pid, indexDir } = await daemonOutside('.codegraph-b', 'deleted');
    fs.rmSync(indexDir, { recursive: true });
    expect(await stopAllDaemons()).toMatchObject([{ pid, outcome: 'term' }]);
    expect(fs.existsSync(indexDir)).toBe(false);
    expect(registryFiles()).toEqual([]);
  });

  it('leaves the default to the index that is left when WSL\'s default index is deleted under its daemon', async () => {
    __setWslWindowsDriveForTests(() => true);
    fs.mkdirSync(path.join(root, '.codegraph'));
    fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), '');
    fs.mkdirSync(path.join(root, '.codegraph-wsl'));
    const { pid, indexDir } = await daemonOutside('', 'deleted-wsl');
    expect(indexDir).toBe(path.join(root, '.codegraph-wsl'));
    // Deleting `.codegraph-wsl` goes back to `.codegraph`, and stopping its daemon must not undo that.
    fs.rmSync(indexDir, { recursive: true });
    expect(await stopAllDaemons()).toMatchObject([{ pid, outcome: 'term' }]);
    expect(getDaemonIndexDir(root)).toBe(path.join(root, '.codegraph'));
  });

  describe('a record an older release filed under the root', () => {
    it('shows the index its daemon served by its socket or its lock, never the reader\'s', () => {
      configure('.codegraph-b');
      const project = (name: string): string => {
        const dir = path.join(home, name);
        fs.mkdirSync(dir);
        return dir;
      };
      const legacy = (at: string, socketPath: string, startedAt: number): void => {
        fs.mkdirSync(getRegistryDir(), { recursive: true });
        fs.writeFileSync(
          path.join(getRegistryDir(), `${nameHash(at)}.json`),
          JSON.stringify({ root: at, pid: process.pid, version: '1.6.1', socketPath, startedAt }),
        );
      };
      // An in-project socket is `<index dir>/daemon.sock`.
      const inProject = project('in-project');
      legacy(inProject, path.join(inProject, '.codegraph-a', 'daemon.sock'), 1);
      // A fallback socket names no index; the data directory whose lock names the daemon does.
      const fallback = path.join(os.tmpdir(), 'codegraph-0123456789abcdef.sock');
      const locked = project('locked');
      fs.mkdirSync(path.join(locked, '.codegraph-a'));
      fs.writeFileSync(
        path.join(locked, '.codegraph-a', 'daemon.pid'),
        encodeLockInfo({ pid: process.pid, version: '1.6.1', socketPath: fallback, startedAt: 2 }),
      );
      legacy(locked, fallback, 2);
      // When no lock names it, its index is unknown: never the reader's own.
      const unknown = project('unknown');
      fs.mkdirSync(path.join(unknown, '.codegraph-b'));
      legacy(unknown, fallback, 3);
      // A lock naming its pid with another socket is a daemon's that got the same pid.
      const reused = project('reused');
      fs.mkdirSync(path.join(reused, '.codegraph-a'));
      fs.writeFileSync(
        path.join(reused, '.codegraph-a', 'daemon.pid'),
        encodeLockInfo({ pid: process.pid, version: '1.6.2', socketPath: path.join(reused, '.codegraph-a', 'daemon.sock'), startedAt: 4 }),
      );
      legacy(reused, fallback, 4);

      expect(Object.fromEntries(listDaemons().map(rec => [rec.root, rec.indexDir]))).toEqual({
        [inProject]: path.join(inProject, '.codegraph-a'),
        [locked]: path.join(locked, '.codegraph-a'),
        [unknown]: null,
        [reused]: null,
      });
    });

    it('is pruned by the file it was read from, never another index\'s record', async () => {
      // A live daemon of this release serving `.codegraph-b`, the reader's index.
      await listeningDaemon('.codegraph-b', process.pid);
      const current = registryFiles();
      // An older release's record of the same root, whose pid no daemon answers for.
      fs.writeFileSync(path.join(getRegistryDir(), `${nameHash(fs.realpathSync.native(root))}.json`), JSON.stringify({
        root, pid: process.pid, version: '1.6.1', socketPath: path.join(home, 'gone.sock'), startedAt: 1,
      }));

      expect((await listVerifiedDaemons()).map(rec => rec.indexDir)).toEqual([getCodeGraphDir(root)]);
      expect(registryFiles()).toEqual(current);
      expect((await listVerifiedDaemons()).map(rec => rec.indexDir)).toEqual([getCodeGraphDir(root)]);
    });

    it('is never stopped by its pid alone: the pid must still answer as that daemon', async () => {
      // Its daemon is gone and another process has its pid.
      const pid = startDetachedProcess();
      detached.push(pid);
      const file = path.join(getRegistryDir(), `${nameHash(fs.realpathSync.native(root))}.json`);
      const written = { root, pid, version: '1.6.1', socketPath: rootDaemonSocketPath(root), startedAt: 1 };
      fs.mkdirSync(getRegistryDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(written));
      const [rec] = listDaemons();
      expect(rec!.indexDir).toBeNull();
      const kill = vi.spyOn(process, 'kill');

      expect(await stopRecordedDaemon(rec!)).toEqual({ root, pid, outcome: 'unverified', version: '1.6.1' });
      expect(kill.mock.calls.filter(([target, signal]) => target === pid && signal !== 0)).toEqual([]);
      expect(isProcessAlive(pid)).toBe(true);
      expect(readJson(file)).toEqual(written);
    });

    describe.runIf(POSIX)('with its daemon running', () => {
      it.each(['.codegraph-a', 'index-a'])(
        'never stops the daemon of another index (%s) for an index without one',
        async (name) => {
          const older = await olderReleaseDaemon(name);
          for (const reader of ['.codegraph-b', '']) {
            vi.stubEnv('CODEGRAPH_DIR', reader);
            expect(await stopDaemonAt(root, { preserveUnverified: true })).toEqual({ root, pid: null, outcome: 'no-daemon' });
          }
          expect(isProcessAlive(older.pid)).toBe(true);
          expect(readJson(older.recordFile)?.pid).toBe(older.pid);
          expect((await listVerifiedDaemons()).map(rec => rec.pid)).toEqual([older.pid]);
        },
        30_000,
      );

      it.each(['.codegraph-a', 'index-a'])('stops only the daemon picked from its row (%s)', async (name) => {
        const older = await olderReleaseDaemon(name);
        // The reader's own daemon, a process a wrong stop would reach instead.
        const pid = startDetachedProcess();
        detached.push(pid);
        await listeningDaemon('.codegraph-b', pid);
        const current = listDaemons().find(rec => rec.pid === pid)!;
        const notes: string[] = [];
        let rows: PickItem[] = [];
        await runDaemonPicker({
          list: listVerifiedDaemons,
          stop: stopRecordedDaemon,
          stopAll: async () => { throw new Error('not picked'); },
          cwdRoot: root,
          now: () => Date.now(),
          select: async ({ options }) => {
            if (rows.length) return CANCEL;
            rows = options;
            return options.find(row => row.hint?.includes(`pid ${older.pid} `))!.value;
          },
          isCancel: () => false,
          note: (message) => notes.push(message),
          done: () => {},
        });
        const values = rows.map(row => row.value);
        expect(new Set(values).size).toBe(values.length);
        expect(rows[0]).toMatchObject({ value: current.file, label: `${root}  (current project)` });
        expect(notes).toEqual([`Stopped daemon (pid ${older.pid}) — ${root} (index ${name === 'index-a' ? 'unknown' : name})`]);
        await older.exited();
        expect(isProcessAlive(pid)).toBe(true);
        expect(fs.existsSync(older.recordFile)).toBe(false);
        expect(listDaemons().map(rec => rec.file)).toEqual([current.file]);
      }, 30_000);

      it('is stopped by stop --all, by its pid, when its index is unknown', async () => {
        const older = await olderReleaseDaemon('index-a');
        const pid = startDetachedProcess();
        detached.push(pid);
        await listeningDaemon('.codegraph-b', pid);
        const results = await stopAllDaemons();
        expect(results.map(result => `${result.pid} ${result.outcome}`).sort()).toEqual([`${older.pid} term`, `${pid} term`].sort());
        expect(isProcessAlive(pid)).toBe(false);
        await older.exited();
        expect(registryFiles()).toEqual([]);
        expect(fs.existsSync(older.socketPath)).toBe(false);
      }, 30_000);

      it('clears the record and socket of a daemon of unknown index it had to kill', async () => {
        const older = await olderReleaseDaemon('index-a', { stuck: true });
        const [rec] = await listVerifiedDaemons();
        expect(rec).toMatchObject({ pid: older.pid, indexDir: null });
        expect(await stopRecordedDaemon(rec!)).toMatchObject({ pid: older.pid, outcome: 'kill' });
        await older.exited();
        expect(fs.existsSync(older.recordFile)).toBe(false);
        expect(fs.existsSync(older.socketPath)).toBe(false);
        // Its lock is left to the next daemon of its index, which clears a dead holder's.
        expect(fs.existsSync(older.lockFile)).toBe(true);
      }, 30_000);

      it('leaves the socket another index\'s older daemon listens on when it clears a stale lock that names it', async () => {
        const older = await olderReleaseDaemon('.codegraph-a');
        // `.codegraph-b`'s lock names the same fallback: its own older daemon bound it, and died.
        configure('.codegraph-b');
        fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({
          pid: await deadPid(), version: '0.0.1', socketPath: older.socketPath, startedAt: 1,
        }));
        expect(await clearStaleDaemonArtifacts(root)).toBe(true);
        expect(fs.existsSync(getDaemonPidPath(root))).toBe(false);
        expect(fs.existsSync(older.socketPath)).toBe(true);
        expect((await listVerifiedDaemons()).map(daemon => daemon.pid)).toEqual([older.pid]);
      }, 30_000);
    });
  });

  it.runIf(POSIX).each([['another index', '.codegraph-a'], ['the default index', '']])(
    'leaves no record, socket or lock of an older daemon of %s it had to kill to replace',
    async (_index, name) => {
      const older = await olderReleaseDaemon(name || '.codegraph', { stuck: true });
      vi.stubEnv('CODEGRAPH_DIR', name);
      expect(await stopOlderDaemon(root, '1.6.3')).toMatchObject({ pid: older.pid, outcome: 'kill', version: '0.0.1' });
      expect(fs.existsSync(older.lockFile)).toBe(false);
      expect(fs.existsSync(older.socketPath)).toBe(false);
      expect(registryFiles()).toEqual([]);
      // The writer slot stays with this launcher, for the daemon it starts next.
      expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'handover' });
      releaseWriterLock(root);
    },
    30_000,
  );

  describe('the daemon list and picker', () => {
    const record = (at: string, indexDir: string | null, pid: number, startedAt = pid): DaemonRecord => ({
      root: at,
      indexDir,
      pid,
      version: '1.6.2',
      socketPath: path.join(at, 'daemon.sock'),
      startedAt,
      file: path.join(home, `${pid}.json`),
    });

    it('marks only the reader\'s own index as the current project, and selects it first', async () => {
      configure('.codegraph-b');
      const newer = record(root, path.join(root, '.codegraph-a'), 1, 2);
      const mine = record(root, path.join(root, '.codegraph-b'), 2, 1);
      const items = buildPickItems([newer, mine], root, 3);
      expect(items[0]).toMatchObject({ value: mine.file, label: `${root}  (current project)` });
      expect(items[1]).toMatchObject({ value: newer.file, label: root });

      let initial: string | undefined;
      await runDaemonPicker({
        list: () => [newer, mine],
        stop: async () => { throw new Error('not picked'); },
        stopAll: async () => [],
        cwdRoot: root,
        now: () => 3,
        select: async ({ initialValue }) => { initial = initialValue; return CANCEL; },
        isCancel: () => false,
        note: () => {},
        done: () => {},
      });
      expect(initial).toBe(mine.file);
    });

    it('names the index beside the root only where the root does not say which', () => {
      const other = path.join(home, 'other');
      const alone = record(other, path.join(other, '.codegraph'), 1);
      const custom = record(other, path.join(other, '.codegraph-b'), 2);
      expect(describeDaemon(alone, [alone])).toBe(other);
      expect(describeDaemon(custom, [custom])).toBe(`${other} (index .codegraph-b)`);

      const shared = [
        record(root, path.join(root, '.codegraph'), 3),
        record(root, path.join(root, '.codegraph-b'), 4),
        record(root, null, 5),
      ];
      expect(shared.map(daemon => describeDaemon(daemon, shared))).toEqual([
        `${root} (index .codegraph)`,
        `${root} (index .codegraph-b)`,
        `${root} (index unknown)`,
      ]);
      const items = buildPickItems([...shared, alone], null, 10_000);
      expect(items.find(item => item.value === alone.file)?.hint).toMatch(/^pid 1 · /);
      expect(items.find(item => item.value === shared[1]!.file)?.hint).toMatch(/^index \.codegraph-b · pid 4 · /);
    });

    it('prints which index each daemon serves in the plain list', async () => {
      const other = path.join(home, 'other');
      fs.mkdirSync(other);
      await listeningDaemon('', process.pid);
      await listeningDaemon('.codegraph-b', process.pid);
      await listeningDaemon('', process.pid, other);
      const { stdout } = await promisify(execFile)(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'daemon'], {
        env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' },
        encoding: 'utf8',
      });
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(3);
      for (const place of [other, `${root} (index .codegraph)`, `${root} (index .codegraph-b)`]) {
        expect(lines.filter(line => line.endsWith(`  ${place}`)), place).toHaveLength(1);
      }
    }, 60_000);
  });

  it('joins on its own candidates only the daemon its index\'s lock names, when it names one', async () => {
    configure('.codegraph-b');
    const socketPath = listenPath('daemon');
    await answer(socketPath, process.pid, CodeGraphPackageVersion);
    const joined = async (): Promise<boolean> => {
      const socket = await connectIndexDaemon(root, socketPath);
      if (socket instanceof net.Socket) socket.destroy();
      return socket instanceof net.Socket;
    };
    expect(await joined()).toBe(true);
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid: await deadPid(), version: CodeGraphPackageVersion, socketPath, startedAt: 1 }));
    expect(await joined()).toBe(false);
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid: process.pid, version: CodeGraphPackageVersion, socketPath, startedAt: 1 }));
    expect(await joined()).toBe(true);
  });

  it('joins under the root\'s name only the daemon its index\'s lock names, and without a lock none', async () => {
    configure('.codegraph-b');
    const socketPath = rootDaemonSocketPath(root);
    tmpSockets.push(socketPath);
    let connections = 0;
    await answer(socketPath, process.pid, CodeGraphPackageVersion, () => { connections++; });
    const joined = async (): Promise<boolean> => {
      const socket = await connectRootNamedDaemon(root);
      if (socket instanceof net.Socket) socket.destroy();
      return socket instanceof net.Socket;
    };
    // Another index's daemon of a release before this one may hold the name.
    expect(await joined()).toBe(false);
    expect(connections).toBe(0);
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid: await deadPid(), version: CodeGraphPackageVersion, socketPath, startedAt: 1 }));
    expect(await joined()).toBe(false);
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid: process.pid, version: CodeGraphPackageVersion, socketPath, startedAt: 1 }));
    expect(await joined()).toBe(true);
  });

  /**
   * Sessions of the built CLI, and the daemons they start: an agent's
   * `serve --mcp`, attached to a shared daemon, or serving itself in-process.
   */
  describe.runIf(POSIX)('a session', () => {
    interface Session { child: ChildProcessWithoutNullStreams; stdout: string[]; stderr: string[] }
    const sessions: Session[] = [];
    const projects: string[] = [];

    afterEach(async () => {
      await Promise.all(sessions.splice(0).map(async ({ child }) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }));
      // Every daemon the sessions started, losers of the lock race included.
      const daemons = projects.splice(0).flatMap(project => recordedPids(project));
      for (const pid of daemons) {
        if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
      }
      await waitFor(() => daemons.every(pid => !isProcessAlive(pid)), 10_000, 'the sessions\' daemons to exit').catch(() => {
        for (const pid of daemons) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      });
    }, 30_000);

    function lines(stream: NodeJS.ReadableStream, into: string[]): void {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let at: number;
        while ((at = buffer.indexOf('\n')) !== -1) {
          into.push(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      });
    }

    function send(session: Session, message: unknown): void {
      try { session.child.stdin.write(JSON.stringify(message) + '\n'); } catch { /* gone */ }
    }

    /**
     * A session in `at` for the index `codegraphDir` names, given node `flags`.
     * It retries a daemon it missed every 300 ms, so a loaded machine's slow
     * daemon start is joined the moment it binds.
     */
    function startSession(at: string, codegraphDir: string, flags: string[] = [], env: NodeJS.ProcessEnv = {}): Session {
      if (!projects.includes(at)) projects.push(at);
      const recorder = recordSpawns(at);
      const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...flags, ...recorder.args, BIN, 'serve', '--mcp', '--path', at], {
        cwd: at,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...recorder.env,
          CODEGRAPH_DIR: codegraphDir,
          CODEGRAPH_MCP_LOG_ATTACH: '1',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '30000',
          CODEGRAPH_DAEMON_RETRY_MS: '300',
          CODEGRAPH_DAEMON_RETRY_MAX_MS: '600',
          CODEGRAPH_NO_UPDATE_CHECK: '1',
          ...env,
        },
      }) as ChildProcessWithoutNullStreams;
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      const session: Session = { child, stdout: [], stderr: [] };
      lines(child.stdout, session.stdout);
      lines(child.stderr, session.stderr);
      sessions.push(session);
      send(session, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
      });
      return session;
    }

    /** The daemon a session attached to: where, and its pid. */
    async function attachedTo(session: Session, nth = 1): Promise<{ socketPath: string; pid: number }> {
      const line = await waitFor(
        () => session.stderr.filter(entry => entry.includes('Attached to shared daemon on '))[nth - 1],
        60_000,
        `a session to attach (${nth})`,
      ).catch((err: Error) => { throw new Error(`${err.message}\n--- stderr ---\n${session.stderr.join('\n')}`); });
      const [, socketPath, pid] = /Attached to shared daemon on (.+) \(pid (\d+), v/.exec(line)!;
      return { socketPath: socketPath!, pid: Number(pid) };
    }

    /** A session's answer to a `codegraph_status` call, once it has one. */
    async function status(session: Session, id: number): Promise<any> {
      send(session, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
      return waitFor(
        () => session.stdout.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(message => message?.id === id),
        30_000,
        `the status call ${id} to be answered`,
      );
    }

    async function index(at: string, codegraphDir: string): Promise<void> {
      vi.stubEnv('CODEGRAPH_DIR', codegraphDir);
      fs.mkdirSync(at, { recursive: true });
      fs.writeFileSync(path.join(at, 'a.ts'), 'export function alpha() { return 1; }\n');
      const cg = await CodeGraph.init(at);
      try { await cg.indexAll(); } finally { cg.close(); }
    }

    it('starts a daemon of its own for the index WSL picks once it changes', async () => {
      // A root long enough that every daemon listens on its tmpdir fallback.
      const project = path.join(home, 'a'.repeat(80), 'project');
      __setWslWindowsDriveForTests(() => true);
      await index(project, '.codegraph');
      for (const name of ['.codegraph', '.codegraph-wsl']) {
        tmpSockets.push(...getDaemonSocketCandidates(project, path.join(project, name)));
      }
      const session = startSession(project, '', ['--require', WSL_WINDOWS_DRIVE]);
      const first = await attachedTo(session);
      expect(readJson(path.join(project, '.codegraph', 'daemon.pid'))?.pid).toBe(first.pid);
      // Its daemon has opened its index: one still starting would resolve the default again.
      await status(session, 2);

      // What `CODEGRAPH_DIR=.codegraph-wsl codegraph init` does: the index sessions get by default changes.
      await index(project, '.codegraph-wsl');
      const second = await attachedTo(startSession(project, '', ['--require', WSL_WINDOWS_DRIVE]));
      expect(second.pid).not.toBe(first.pid);
      expect(second.socketPath).not.toBe(first.socketPath);
      expect(readJson(path.join(project, '.codegraph-wsl', 'daemon.pid'))?.pid).toBe(second.pid);
      expect(listDaemons().map(rec => rec.pid).sort()).toEqual([first.pid, second.pid].sort());

      // Stopped, the first daemon removes its own record, though its root now resolves to the other index.
      const firstRecord = path.join(getRegistryDir(), `${nameHash(fs.realpathSync.native(path.join(project, '.codegraph')))}.json`);
      expect(readJson(firstRecord)?.pid).toBe(first.pid);
      process.kill(first.pid, 'SIGTERM');
      await waitFor(() => !isProcessAlive(first.pid), 20_000, 'the first daemon to exit');
      expect(fs.existsSync(firstRecord)).toBe(false);
      expect(listDaemons().map(rec => rec.pid)).toEqual([second.pid]);
    }, 150_000);

    it('joins the daemon of the index WSL picks once it changes, when its own daemon goes', async () => {
      const project = path.join(home, 'a'.repeat(80), 'project');
      __setWslWindowsDriveForTests(() => true);
      await index(project, '.codegraph');
      for (const name of ['.codegraph', '.codegraph-wsl']) {
        tmpSockets.push(...getDaemonSocketCandidates(project, path.join(project, name)));
      }
      const session = startSession(project, '', ['--require', WSL_WINDOWS_DRIVE]);
      const first = await attachedTo(session);
      await status(session, 2);

      // `.codegraph-wsl` becomes the default, then the session's daemon is stopped.
      await index(project, '.codegraph-wsl');
      process.kill(first.pid, 'SIGTERM');
      const second = await attachedTo(session, 2);
      expect(second.pid).not.toBe(first.pid);
      expect(readJson(path.join(project, '.codegraph-wsl', 'daemon.pid'))?.pid).toBe(second.pid);
    }, 150_000);

    it('joins a daemon of its own version from before indexes had names of their own, and only for that index', async () => {
      await index(root, '.codegraph-a');
      await index(root, '');
      const older = await olderReleaseDaemon('.codegraph-a', { version: CodeGraphPackageVersion });
      tmpSockets.push(...getDaemonSocketCandidates(root, path.join(root, '.codegraph')));

      const joined = await attachedTo(startSession(root, '.codegraph-a'));
      expect(joined).toEqual({ socketPath: rootDaemonSocketPath(root), pid: older.pid });
      // The default index's session finds that daemon under the root's name too, but
      // its own lock doesn't name it, so it starts a daemon of its own.
      const own = await attachedTo(startSession(root, ''));
      expect(own.pid).not.toBe(older.pid);
      expect(readJson(path.join(root, '.codegraph', 'daemon.pid'))?.pid).toBe(own.pid);
    }, 150_000);

    it('never sends a session to a socket a lock names, nor to one the lock\'s daemon doesn\'t answer', async () => {
      await index(root, '');
      const [, fallback] = getDaemonSocketCandidates(root);
      tmpSockets.push(fallback!);
      // A lock written by someone else, naming a live process and a socket that answers as it.
      const holder = startDetachedProcess();
      detached.push(holder);
      const planted = listenPath('planted');
      const received: Buffer[] = [];
      const record = (socket: net.Socket): void => { socket.on('data', (chunk: Buffer) => received.push(chunk)); };
      await answer(planted, holder, CodeGraphPackageVersion, record);
      fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid: holder, version: CodeGraphPackageVersion, socketPath: planted, startedAt: 1 }));
      // And a process that is not the daemon the lock names, answering on the index's own fallback.
      await answer(fallback!, process.pid, CodeGraphPackageVersion, record);

      const session = startSession(root, '', [], { CODEGRAPH_DAEMON_RETRY_MS: '0' });
      const reply = await status(session, 2);
      expect(JSON.stringify(reply.result)).toContain('CodeGraph Status');
      expect(session.stderr.some(line => line.includes('Attached to shared daemon'))).toBe(false);
      expect(Buffer.concat(received).length).toBe(0);
    }, 60_000);
  });
});
