/**
 * Project writer lock (#1740) — unit coverage for acquire / re-entrant /
 * stale-dead-pid / live-holder refusal.
 */

import { afterEach, describe, expect, it } from 'vitest';
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

  afterEach(() => {
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
});
