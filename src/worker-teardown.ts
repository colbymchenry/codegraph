/**
 * Ending a worker thread without taking the process down.
 *
 * On Windows, a worker thread that ends — terminated, by its own
 * `process.exit()`, or with the process — while V8's concurrent marker is
 * still marking its heap can crash the whole process with an access violation
 * (exit 3221225477 / 0xC0000005), with no error and no dump. Bisected on a
 * Windows 11 ARM64 VM (Node 24): `--no-concurrent-marking` alone stops it, and
 * no other concurrency flag does — but that flag makes indexing about a third
 * slower, so CodeGraph avoids the dangerous moments instead.
 *
 * Measured there, 480 child processes per row, four workers each:
 *
 *   ended while still loading CodeGraph's modules      18 crashed
 *   loaded and allocating, terminated by the owner       4 crashed
 *   loaded and allocating, exiting by itself             1 crashed
 *   loaded and allocating, full collection, then exit    0 crashed
 *
 * So an owner never ends a worker that is still starting (it waits for the
 * worker's first message, which is posted only after its modules load), and a
 * worker that is about to exit collects garbage first — a full collection
 * finishes any marking in flight.
 */

import type { Worker } from 'worker_threads';

/**
 * Longest an owner waits for a worker to finish starting before terminating
 * it anyway. A start takes about a second normally and a few under heavy
 * load; the cap only bounds a start that is wedged.
 */
export const WORKER_START_SETTLE_MS = 15_000;

/**
 * Settles once `worker` has started — its first message — or has gone away.
 * Call it right after creating the worker, before it can post anything.
 */
export function workerStarted(worker: Worker): Promise<void> {
  return new Promise<void>((resolve) => {
    worker.once('message', () => resolve());
    worker.once('error', () => resolve());
    worker.once('exit', () => resolve());
  });
}

/**
 * Terminate `worker`, but not while it is still starting: wait for `started`
 * (from {@link workerStarted}) first, up to `capMs`. Never rejects.
 */
export async function terminateOnceStarted(
  worker: Pick<Worker, 'terminate'>,
  started: Promise<void>,
  capMs = WORKER_START_SETTLE_MS
): Promise<void> {
  let cap: NodeJS.Timeout | undefined;
  await Promise.race([
    started,
    new Promise<void>((resolve) => {
      cap = setTimeout(resolve, capMs);
      cap.unref?.();
    }),
  ]);
  clearTimeout(cap);
  try {
    await worker.terminate();
  } catch {
    // already gone
  }
}

let collect: (() => void) | null | undefined;

/**
 * In a worker that is about to exit: run a full garbage collection, so no
 * marking is in flight when the thread ends. Returns whether one ran. The
 * collector is reached at runtime (no `--expose-gc` on the command line) and
 * is never exposed as a global.
 */
export function collectBeforeExit(): boolean {
  if (collect === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('v8') as typeof import('v8')).setFlagsFromString('--expose-gc');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      collect = (require('vm') as typeof import('vm')).runInNewContext('gc') as () => void;
      // Only the context made above needed it; workers created later don't get a global gc.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('v8') as typeof import('v8')).setFlagsFromString('--no-expose-gc');
    } catch {
      collect = null;
    }
  }
  if (!collect) return false;
  try {
    collect();
    return true;
  } catch {
    return false;
  }
}
