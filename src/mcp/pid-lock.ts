/** Short-lived mutation barrier for the authoritative writer and daemon PID records. */
import * as fs from 'fs';
import { FileLock } from '../utils';

// Longer than the daemon refresh's 1.575 s Windows sharing-violation retry chain.
// Waiting is bounded: a suspended holder must not freeze the event loop forever.
const PID_LOCK_WAIT_MS = 5_000;
const PID_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Every create, compare-and-replace, and compare-and-delete of a PID record
 * participates, including initial publication: an absent record can become
 * owned between a cleaner's last read and unlink. Reuse FileLock's `.break`
 * protocol and bounded stale-breaker recovery rather than a second lock scheme.
 * This barrier is synchronous and non-reentrant; no caller holds it over await.
 * Try-acquire callers return `busy` immediately. Owner mutations wait briefly
 * so a competing reader/mutator cannot strand release, readiness, or handover.
 * Only acquisition failures select `busy`; errors in `action` still propagate.
 */
export function withPidLock<T>(pidPath: string, action: () => T, busy: () => T, opts: { wait?: boolean } = {}): T {
  const barrier = new FileLock(`${pidPath}.break`);
  const deadline = performance.now() + (opts.wait ? PID_LOCK_WAIT_MS : 0);
  for (;;) {
    try {
      barrier.acquire();
      break;
    } catch (error) {
      // FileLock's contention error has no errno. Permanent filesystem errors
      // (including a missing parent on best-effort release) cannot benefit from retry.
      if ((error as NodeJS.ErrnoException).code || performance.now() >= deadline) return busy();
      Atomics.wait(PID_LOCK_WAIT, 0, 0, Math.min(10, deadline - performance.now()));
    }
  }
  try {
    return action();
  } finally {
    barrier.release();
  }
}

/** Match FileLock's grace for O_EXCL publication, including FAT's coarse timestamps. */
const EMPTY_PID_GRACE_MS = 10_000;

/** An empty record can be mid-publication, not corrupt; failed stat is inconclusive. */
export function isPidLockPending(pidPath: string, raw: string): boolean {
  if (raw.trim() !== '') return false;
  try {
    return Date.now() - fs.statSync(pidPath).mtimeMs < EMPTY_PID_GRACE_MS;
  } catch {
    return true;
  }
}
