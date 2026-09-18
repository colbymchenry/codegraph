/**
 * Project writer lock (#1740) — unit coverage for acquire / re-entrant /
 * stale-dead-pid / live-holder refusal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPEngine } from '../src/mcp/engine';
import {
  decodeWriterLockInfo,
  getWriterPidPath,
  releaseWriterLock,
  tryAcquireWriterLock,
  writerLockHeldMessage,
} from '../src/mcp/writer-lock';

describe('writer lock (#1740)', () => {
  let dir: string;
  let holder: ChildProcess | null = null;

  afterEach(() => {
    try { holder?.kill('SIGKILL'); } catch { /* already gone */ }
    holder = null;
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
    // Use our own pid first, then overwrite with a fake live-looking pid by
    // writing a pid that is alive: process.pid of this test — simulate foreign
    // by writing a different alive pid. On Linux, PID 1 is almost always alive.
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: 1, mode: 'direct', startedAt: Date.now() }) + '\n',
      { flag: 'wx' },
    );
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') {
      expect(r.existing?.pid).toBe(1);
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

  it('lets a fallback engine atomically claim and release writer ownership', () => {
    const root = makeProject();
    const engine = new MCPEngine({ writerLockRoot: root });

    expect(decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(root), 'utf8'))).toMatchObject({
      pid: process.pid,
      mode: 'fallback',
    });

    engine.stop();
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('rejects a fallback engine before opening when another process owns writer.pid', () => {
    const root = makeProject();
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Failed to spawn writer-lock holder');
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: holder.pid, mode: 'daemon', startedAt: Date.now() }) + '\n',
    );

    expect(() => new MCPEngine({ writerLockRoot: root })).toThrow(/writer lock held/i);
  });
});
