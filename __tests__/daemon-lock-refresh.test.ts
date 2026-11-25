import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { refreshDaemonLock, type DaemonLockInfo } from '../src/mcp/daemon';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe('daemon ownership refresh under Windows sharing violations', () => {
  let root: string;
  let pidPath: string;
  let initial: string;
  let lock: DaemonLockInfo;
  let realRename: typeof fs.renameSync;

  beforeEach(async () => {
    realRename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
    vi.mocked(fs.renameSync).mockReset().mockImplementation(realRename);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-refresh-'));
    pidPath = path.join(root, 'daemon.pid');
    lock = { pid: process.pid, version: 'test', socketPath: 'bound-socket', startedAt: Date.now() };
    initial = JSON.stringify({ ...lock, socketPath: 'original-socket' });
    fs.writeFileSync(pidPath, initial);
  });

  afterEach(() => {
    vi.mocked(fs.renameSync).mockReset();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const denied = (code: string) => Object.assign(new Error('sharing violation'), { code });
  const noTemporaryFile = () => expect(fs.readdirSync(root)).toEqual(['daemon.pid']);

  it.each(['EPERM', 'EACCES', 'EBUSY'])('survives a transient %s without exposing a partial record', (code) => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(initial);
      throw denied(code);
    });
    refreshDaemonLock(pidPath, initial, lock, 'win32');
    expect(JSON.parse(fs.readFileSync(pidPath, 'utf8'))).toEqual(lock);
    expect(fs.renameSync).toHaveBeenCalledTimes(2);
    noTemporaryFile();
  });

  it('bounds persistent failures and preserves the original record', () => {
    const error = denied('EPERM');
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error; });
    expect(() => refreshDaemonLock(pidPath, initial, lock, 'win32')).toThrow(error);
    expect(fs.renameSync).toHaveBeenCalledTimes(8);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(initial);
    noTemporaryFile();
  });

  it('does not overwrite an ownership change during a retry', () => {
    const replacement = JSON.stringify({ ...lock, pid: process.pid + 1 });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      fs.writeFileSync(pidPath, replacement);
      throw denied('EPERM');
    });
    expect(() => refreshDaemonLock(pidPath, initial, lock, 'win32')).toThrow('Lost daemon lock ownership');
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(replacement);
    noTemporaryFile();
  });

  it.each([['linux', 'EPERM'], ['darwin', 'EACCES'], ['win32', 'ENOSPC']] as const)(
    'does not retry %s / %s', (platform, code) => {
      const error = denied(code);
      vi.mocked(fs.renameSync).mockImplementation(() => { throw error; });
      expect(() => refreshDaemonLock(pidPath, initial, lock, platform)).toThrow(error);
      expect(fs.renameSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(pidPath, 'utf8')).toBe(initial);
      noTemporaryFile();
    },
  );

  it.runIf(process.platform === 'win32')('waits for a real Windows handle on the pid file to close', () => {
    // Windows will not replace a file while any handle to it is open, even
    // one that shares delete access, which is how a scanner, an indexer or
    // another process reading the lock trips this path. Hold a real handle,
    // let the first real rename fail, and close it only then, so the retry
    // follows the release by order rather than racing a timer against the
    // backoff (#1773).
    const handle = fs.openSync(pidPath, 'r');
    const held: NodeJS.ErrnoException[] = [];
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      try {
        realRename(from, to);
      } catch (error) {
        held.push(error as NodeJS.ErrnoException);
        fs.closeSync(handle);
        throw error;
      }
    });
    try {
      refreshDaemonLock(pidPath, initial, lock);
    } finally {
      if (held.length === 0) fs.closeSync(handle);
    }
    expect(held).toHaveLength(1);
    expect(['EPERM', 'EACCES', 'EBUSY']).toContain(held[0]!.code);
    expect(vi.mocked(fs.renameSync).mock.calls.length).toBeGreaterThan(1);
    expect(JSON.parse(fs.readFileSync(pidPath, 'utf8'))).toEqual(lock);
    noTemporaryFile();
  });
});
