import { existsSync } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

export interface PendingChangeCounts {
  added: number;
  modified: number;
  removed: number;
}

/** `getChangedFiles()` may fall back to a huge filesystem scan (#1959). */
const MEASURE_TIMEOUT_MS = 8_000;
const active = new Map<string, Promise<PendingChangeCounts | null>>();

export function measurePendingChanges(root: string): Promise<PendingChangeCounts | null> {
  const key = path.resolve(root);
  const existing = active.get(key);
  if (existing) return existing;

  const pending = runMeasurement(key).finally(() => active.delete(key));
  active.set(key, pending);
  return pending;
}

function runMeasurement(root: string): Promise<PendingChangeCounts | null> {
  // The compiled sibling is beside us in production; Vitest loads src/ but
  // builds dist/ before the tests, so use that copy for the worker there.
  const sibling = path.join(__dirname, 'index-freshness-worker.js');
  const workerFile = existsSync(sibling)
    ? sibling
    : path.resolve(__dirname, '../../dist/mcp/index-freshness-worker.js');
  if (!existsSync(workerFile)) return Promise.resolve(null);

  let worker: Worker;
  try {
    worker = new Worker(workerFile, { workerData: { root } });
  } catch {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (counts: PendingChangeCounts | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(counts);
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);
    worker.once('message', (value: PendingChangeCounts | null) => {
      const valid = value && typeof value === 'object' && ['added', 'modified', 'removed'].every(
        key => Number.isSafeInteger(value[key as keyof PendingChangeCounts]) && value[key as keyof PendingChangeCounts] >= 0,
      );
      finish(valid ? value : null);
    });
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}
