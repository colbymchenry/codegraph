import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getRegistryDir,
  isProcessAlive,
  registerDaemon,
  deregisterDaemon,
  listDaemons,
  type DaemonRecord,
} from '../src/mcp/daemon-registry';

/** A pid that's guaranteed dead: spawn a trivial process, let it exit, reap it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise<void>((r) => child.on('exit', () => r()));
  await new Promise((r) => setTimeout(r, 50)); // let the OS reap it
  return pid;
}

function rec(root: string, pid: number, startedAt = Date.now()): DaemonRecord {
  return { root, pid, version: '1.0.0', socketPath: `${root}/.codegraph/daemon.sock`, startedAt };
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
});
