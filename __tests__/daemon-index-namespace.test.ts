import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot, getCodeGraphDir } from '../src/directory';
import { encodeLockInfo, getDaemonPidPath, getDaemonSocketCandidates, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { buildPickItems, CANCEL, runDaemonPicker } from '../src/mcp/daemon-manager';
import { deregisterDaemon, getRegistryDir, listDaemons, listVerifiedDaemons, registerDaemon, stopAllDaemons, stopDaemonAt } from '../src/mcp/daemon-registry';

describe('daemon index namespaces', () => {
  let home: string;
  let root: string;
  const servers: net.Server[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ns-'));
    root = path.join(home, 'project');
    fs.mkdirSync(root);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
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

  async function listeningDaemon(name: string, pid: number): Promise<void> {
    configure(name);
    const socketPath = getDaemonSocketPath(root);
    const lock = { pid, version: '1.6.2', socketPath, startedAt: pid };
    const server = net.createServer(socket => {
      socket.end(JSON.stringify({ protocol: 1, codegraph: lock.version, pid }) + '\n');
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo(lock));
    registerDaemon({ root, ...lock });
  }

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

  it('keeps both registry records and deregisters only the configured index', () => {
    const one = configure('.codegraph-one');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 1 });
    const two = configure('.codegraph-two');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 2 });
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([canonicalProjectRoot(two), canonicalProjectRoot(one)]);
    expect(fs.readdirSync(getRegistryDir())).toHaveLength(2);
    deregisterDaemon(root);
    expect(listDaemons().map(rec => rec.indexDir)).toEqual([canonicalProjectRoot(one)]);
  });

  it('converges symlinked project spellings on one socket and registry entry', () => {
    configure('.codegraph-one');
    const alias = path.join(home, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    expect(getDaemonSocketCandidates(alias)).toEqual(getDaemonSocketCandidates(root));
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

  it('preserves a live record without namespace proof without selecting its process', async () => {
    configure('.codegraph-current');
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    const uncertainPath = path.join(getRegistryDir(), 'uncertain.json');
    fs.writeFileSync(uncertainPath, JSON.stringify({
      root, pid: process.pid, version: '1.6.2', socketPath: 'unverified', startedAt: 1,
    }));
    const kill = vi.spyOn(process, 'kill');
    expect(await listVerifiedDaemons()).toEqual([]);
    expect(await stopDaemonAt(root)).toEqual({ root, pid: null, outcome: 'no-daemon' });
    expect(fs.existsSync(uncertainPath)).toBe(true);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it('prunes an unverified record from its own namespace while preserving another live one', async () => {
    await listeningDaemon('.codegraph-one', process.pid);
    const one = getCodeGraphDir(root);
    configure('.codegraph-two');
    registerDaemon({ root, pid: process.pid, version: '1.6.2', socketPath: getDaemonSocketPath(root), startedAt: 2 });
    configure('.codegraph-one');
    expect((await listVerifiedDaemons()).map(rec => rec.indexDir)).toEqual([canonicalProjectRoot(one)]);
    expect(listDaemons()).toHaveLength(1);
    expect(listDaemons()[0].indexDir).toBe(canonicalProjectRoot(one));
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
    await listeningDaemon('.codegraph-one', pids[0]);
    const one = getCodeGraphDir(root);
    await listeningDaemon('.codegraph-two', pids[1]);
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

  it('selects the exact namespace when two daemons share one project root', async () => {
    const first = { root, indexDir: path.join(root, '.codegraph-one'), pid: 1, version: '1.6.2', socketPath: 'one', startedAt: 1 };
    const second = { ...first, indexDir: path.join(root, '.codegraph-two'), pid: 2, socketPath: 'two', startedAt: 2 };
    const daemons = [first, second];
    const items = buildPickItems(daemons, root, 3);
    expect(items[0].value).not.toBe(items[1].value);
    const stop = vi.fn(async () => ({ root, pid: second.pid, outcome: 'term' as const }));
    const select = vi.fn().mockResolvedValueOnce(second.indexDir).mockResolvedValueOnce(CANCEL);
    await runDaemonPicker({
      list: () => daemons,
      stop,
      stopAll: async () => [],
      cwdRoot: root,
      now: () => 3,
      select,
      isCancel: () => false,
      note: () => {},
      done: () => {},
    });
    expect(stop).toHaveBeenCalledWith(root, { indexDir: second.indexDir });
  });
});
