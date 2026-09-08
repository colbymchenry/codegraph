/**
 * Project writer lock (#1740) — unit coverage for acquire / re-entrant /
 * stale-dead-pid / live-holder refusal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  decodeWriterLockInfo,
  getWriterPidPath,
  releaseWriterLock,
  tryAcquireWriterLock,
  writerLockHeldMessage,
} from '../src/mcp/writer-lock';

describe('writer lock (#1740)', () => {
  let dir: string;
  const foreignHolders: ChildProcess[] = [];

  afterEach(() => {
    for (const child of foreignHolders) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    foreignHolders.length = 0;
    if (dir) {
      releaseWriterLock(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeProject(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-lock-'));
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    return dir;
  }

  it('acquires and releases writer.pid', () => {
    const root = makeProject();
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('acquired');
    expect(fs.existsSync(getWriterPidPath(root))).toBe(true);
    const info = decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(root), 'utf8'));
    expect(info?.pid).toBe(process.pid);
    expect(info?.mode).toBe('direct');
    releaseWriterLock(root);
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('is re-entrant for the same pid', () => {
    const root = makeProject();
    expect(tryAcquireWriterLock(root, 'daemon').kind).toBe('acquired');
    const again = tryAcquireWriterLock(root, 'fallback');
    expect(again.kind).toBe('acquired');
    releaseWriterLock(root);
  });

  it('reports taken when a live foreign pid holds the lock', () => {
    const root = makeProject();
    // A foreign process that is genuinely alive, rather than a pid assumed to
    // be: PID 1 is init on Linux but does not exist on Windows, where the lock
    // then reads the holder as dead and correctly acquires — the assertion was
    // failing on the fixture, not on the lock. A parked child is alive
    // everywhere, and it is what the lock actually promises not to steal from.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    foreignHolders.push(holder);
    expect(holder.pid).toBeGreaterThan(0);
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: holder.pid, mode: 'direct', startedAt: Date.now() }) + '\n',
      { flag: 'wx' },
    );
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') {
      expect(r.existing?.pid).toBe(holder.pid);
      const msg = writerLockHeldMessage(r.existing, r.pidPath);
      expect(msg).toMatch(/writer lock held/i);
      expect(msg).toMatch(/CODEGRAPH_NO_DAEMON/);
      expect(msg).toMatch(/daemon stop/);
    }
  });

  it('clears a stale dead-pid lock and acquires', () => {
    const root = makeProject();
    // Pick a pid that is extremely unlikely to be alive.
    const deadPid = 2147483646;
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: deadPid, mode: 'direct', startedAt: Date.now() }) + '\n',
    );
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('acquired');
    releaseWriterLock(root);
  });
});
