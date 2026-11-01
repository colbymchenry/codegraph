/** Short-lived mutation barrier for the authoritative writer and daemon PID records. */
import * as fs from 'fs';
import { FileLock } from '../utils';

// Longer than the daemon refresh's 1.575 s Windows sharing-violation retry chain.
// Waiting is bounded: a suspended holder must not freeze the event loop forever.
const PID_LOCK_WAIT_MS = 5_000;
const PID_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
// Waits between retries of a barrier removal refused by Windows (another
// process briefly has the file open), as the writer record swap does.
const BARRIER_REMOVE_DELAYS_MS = [25, 50, 100, 200];

/**
 * Barriers whose removal failed on every retry, so this process's pid is still
 * on disk in them. A live pid is never stale, so nothing else may take such a
 * barrier and every later mutation of the record would be refused until the
 * process exits; the next use of the same barrier removes it first.
 */
const unremovedBarriers = new Set<string>();

/**
 * Remove the barrier file while it still holds this process's pid, retrying
 * a refused removal. FileLock.release makes the same ownership check but
 * forgets the lock whether or not the unlink worked, so the failure would go
 * unseen. True once the file is gone or is not ours; false when removal still
 * fails after the last retry.
 */
function removeBarrier(barrierPath: string): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      if (parseInt(fs.readFileSync(barrierPath, 'utf-8'), 10) === process.pid) fs.unlinkSync(barrierPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      const delay = BARRIER_REMOVE_DELAYS_MS[attempt];
      if (delay === undefined) return false;
      Atomics.wait(PID_LOCK_WAIT, 0, 0, delay);
    }
  }
}

/**
 * Every create, compare-and-replace, and compare-and-delete of a PID record
 * participates, including initial publication: an absent record can become
 * owned between a cleaner's last read and unlink. Reuse FileLock's `.break`
 * protocol and bounded stale-breaker recovery rather than a second lock scheme.
 * This barrier is synchronous and non-reentrant; no caller holds it over await.
 * Try-acquire callers return `busy` immediately. Owner mutations wait briefly
 * so a competing reader/mutator cannot strand release, readiness, or handover.
 * Only acquisition failures select `busy`; errors in `action` still propagate.
 * The barrier is removed with retries once `action` is done; if it cannot be
 * removed it is retried at the next use rather than forgotten.
 */
export function withPidLock<T>(pidPath: string, action: () => T, busy: () => T, opts: { wait?: boolean } = {}): T {
  const barrierPath = `${pidPath}.break`;
  if (unremovedBarriers.has(barrierPath) && removeBarrier(barrierPath)) unremovedBarriers.delete(barrierPath);
  const barrier = new FileLock(barrierPath);
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
    // Not barrier.release(): see removeBarrier. `barrier` is not used again.
    if (!removeBarrier(barrierPath)) unremovedBarriers.add(barrierPath);
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
