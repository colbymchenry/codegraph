/**
 * A refused removal of the PID-record mutation barrier is retried, and one that
 * keeps failing is retried at the next use. The barrier names this live
 * process, which no other process may take from it, so forgetting it would
 * refuse every later mutation of the record until the process exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWriterPidPath, markWriterReady, readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../src/mcp/writer-lock';

// A plain-object copy of `fs` shared by this file and every module it loads,
// so vi.spyOn(fs, 'unlinkSync') reaches the lock code (an ESM namespace cannot
// be spied on).
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

describe('PID-record barrier removal', () => {
  let root: string;
  let barrier: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pid-barrier-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    barrier = `${getWriterPidPath(root)}.break`;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Refuse the next `count` removals of the barrier file, as a Windows sharing violation does. */
  function refuseBarrierRemoval(count: number): { refused: () => number } {
    const realUnlink = fs.unlinkSync;
    let refused = 0;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === barrier && refused < count) {
        refused++;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return realUnlink(p);
    }) as typeof fs.unlinkSync);
    return { refused: () => refused };
  }

  it('retries a removal refused once, so the owner can publish readiness and release', () => {
    const injected = refuseBarrierRemoval(1);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('acquired');
    expect(injected.refused()).toBe(1);
    expect(fs.existsSync(barrier)).toBe(false);

    markWriterReady(root);
    expect(readWriterLock(root)?.ready).toBe(true);
    releaseWriterLock(root);
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('removes a barrier whose removal kept failing at the next use of the record', () => {
    // More refusals than one removal retries: the barrier is left holding this pid.
    const injected = refuseBarrierRemoval(5);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('acquired');
    expect(injected.refused()).toBe(5);
    expect(fs.readFileSync(barrier, 'utf8').trim()).toBe(String(process.pid));

    markWriterReady(root);
    expect(readWriterLock(root)?.ready).toBe(true);
    expect(fs.existsSync(barrier)).toBe(false);
    releaseWriterLock(root);
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });
});
