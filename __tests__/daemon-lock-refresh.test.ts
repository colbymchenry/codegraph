import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
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
    expect(fs.renameSync).toHaveBeenCalledTimes(6);
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

  it.runIf(process.platform === 'win32')('waits for a real Windows handle denying delete sharing', async () => {
    // Node opens files with delete sharing; a .NET handle lets us reproduce
    // the real rename failure deterministically without mocking filesystem I/O.
    const script = `$h = [IO.File]::Open('${pidPath.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); `
      + "[Console]::WriteLine('locked'); Start-Sleep -Milliseconds 200; $h.Dispose()";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    try {
      const [ready] = await once(child.stdout, 'data');
      expect(String(ready)).toContain('locked');
      refreshDaemonLock(pidPath, initial, lock);
      expect(vi.mocked(fs.renameSync).mock.calls.length).toBeGreaterThan(1);
      expect(JSON.parse(fs.readFileSync(pidPath, 'utf8'))).toEqual(lock);
      noTemporaryFile();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  }, 10_000);
});
